/**
 * Keyset-cursor codec for history pagination. The cursor is the sort key of
 * the last row on the page - (created_at, id) - base64url-encoded. "Give me
 * whatever sorts before this row" is stable under concurrent inserts, unlike
 * OFFSET, which skips rows as new ones appear.
 */

export interface CursorPayload {
  createdAt: string; // ISO-8601
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
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
