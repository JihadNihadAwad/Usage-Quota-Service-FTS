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
    .select({
      id: requests.id,
      requestId: requests.requestId,
      userId: requests.userId,
      units: requests.units,
      accepted: requests.accepted,
      unitsConsumed: requests.unitsConsumed,
      rejectionLevel: requests.rejectionLevel,
      rejectionRule: requests.rejectionRule,
      monthStart: requests.monthStart,
      createdAt: requests.createdAt,
      // The cursor's timestamp must carry Postgres' microsecond precision -
      // a JS Date truncates to milliseconds, and rows sharing the cursor
      // row's millisecond would fall outside the keyset predicate and get
      // skipped. Keep the original Date for display; this string for paging.
      createdAtKey: sql<string>`to_char(${requests.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(requests)
    .where(and(...conditions))
    // DESC NULLS LAST is not decoration: the recent-history indexes are
    // declared (..., created_at DESC NULLS LAST, id DESC NULLS LAST), and a
    // plain DESC means NULLS FIRST to Postgres - a different sort order,
    // which blocked index-backed ordering entirely (every page did a seq
    // scan + top-N sort of the account's whole ledger). Caught via EXPLAIN
    // ANALYZE; before/after captures live in performance/results/.
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
        ? encodeCursor({ createdAt: last.createdAtKey, id: last.id })
        : null,
  };
}
