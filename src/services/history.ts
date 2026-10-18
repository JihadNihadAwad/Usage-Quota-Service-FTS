import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { requests } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { getUser } from './users.js';

export interface HistoryItem {
  id: number;
  requestId: string;
  userId: string;
  units: number;
  accepted: boolean;
  unitsConsumed: number;
  rejection: { level: string; rule: string } | null;
  month: string; // month_start date
  createdAt: Date;
}

export interface HistoryPage {
  items: HistoryItem[];
  nextCursor: string | null;
}

export interface HistoryFilters {
  userId?: string;
  monthStart?: string;
  outcome?: 'accepted' | 'rejected';
  limit: number;
  cursor?: string;
}

/**
 * Keyset-paginated request history, always scoped to the calling account.
 * Sort: (created_at desc, id desc) - stable under concurrent inserts; the
 * cursor is the last row's sort key, so pages never skip or repeat rows.
 */
export async function listHistory(
  db: Db,
  accountId: string,
  filters: HistoryFilters,
): Promise<HistoryPage> {
  // A user filter must belong to this account; a foreign user id is
  // indistinguishable from a missing one.
  if (filters.userId !== undefined) {
    await getUser(db, accountId, filters.userId);
  }

  const conditions: SQL[] = [eq(requests.accountId, accountId)];
  if (filters.userId !== undefined) conditions.push(eq(requests.userId, filters.userId));
  if (filters.monthStart !== undefined) {
    conditions.push(eq(requests.monthStart, filters.monthStart));
  }
  if (filters.outcome !== undefined) {
    conditions.push(eq(requests.accepted, filters.outcome === 'accepted'));
  }

  if (filters.cursor !== undefined) {
    const cursor = decodeCursor(filters.cursor);
    if (cursor === null) {
      throw new ApiError(400, 'INVALID_CURSOR', 'the provided cursor is not valid');
    }
    conditions.push(
      sql`(${requests.createdAt}, ${requests.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id})`,
    );
  }

  const rows = await db
    .select()
    .from(requests)
    .where(and(...conditions))
    // DESC NULLS LAST is not decoration: the recent-history indexes are
    // declared (..., created_at DESC NULLS LAST, id DESC NULLS LAST), and a
    // plain DESC means NULLS FIRST to Postgres - a different sort order,
    // which blocked index-backed ordering entirely (every page did a seq
    // scan + top-N sort of the account's whole ledger). Caught via EXPLAIN
    // ANALYZE; before/after in performance/results/.
    .orderBy(sql`${requests.createdAt} desc nulls last`, sql`${requests.id} desc nulls last`)
    .limit(filters.limit + 1);

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map((row) => ({
      id: row.id,
      requestId: row.requestId,
      userId: row.userId,
      units: row.units,
      accepted: row.accepted,
      unitsConsumed: row.unitsConsumed,
      rejection:
        row.rejectionLevel !== null && row.rejectionRule !== null
          ? { level: row.rejectionLevel, rule: row.rejectionRule }
          : null,
      month: row.monthStart,
      createdAt: row.createdAt,
    })),
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}
