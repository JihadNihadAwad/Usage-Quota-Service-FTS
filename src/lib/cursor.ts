/**
 * Keyset-cursor codec for history pagination. The cursor is the sort key of
 * the last row on the page - (created_at, id) - base64url-encoded. "Give me
 * whatever sorts before this row" is stable under concurrent inserts, unlike
 * OFFSET, which skips rows as new ones appear.
 */

export interface CursorPayload {
  // ISO-8601 UTC, kept at full precision. Postgres timestamps carry
  // microseconds; a millisecond-truncated value silently drops rows that
  // share the cursor row's millisecond.
  createdAt: string;
  id: number;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { createdAt, id } = parsed as Record<string, unknown>;
    // Shape first (the string goes into a SQL cast), then calendar
    // validity via Date.parse. Fractional seconds of any length pass -
    // the database works in microseconds, older cursors in milliseconds.
    if (typeof createdAt !== 'string') return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(createdAt)) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
