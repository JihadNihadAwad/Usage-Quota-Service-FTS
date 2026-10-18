import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../src/lib/cursor.js';

describe('cursor codec', () => {
  it('round-trips a sort key', () => {
    const payload = { createdAt: '2026-10-18T12:00:00.000Z', id: 42 };
    const decoded = decodeCursor(encodeCursor(payload));
    expect(decoded).toEqual(payload);
  });

  it('rejects garbage without throwing', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull();
  });

  it('rejects a valid base64url of a wrong shape', () => {
    const wrong = Buffer.from(JSON.stringify({ nope: true }), 'utf8').toString('base64url');
    expect(decodeCursor(wrong)).toBeNull();
  });

  it('rejects a non-integer or non-positive id', () => {
    const make = (id: unknown) =>
      Buffer.from(JSON.stringify({ createdAt: '2026-10-18T12:00:00.000Z', id }), 'utf8').toString(
        'base64url',
      );
    expect(decodeCursor(make(1.5))).toBeNull();
    expect(decodeCursor(make(0))).toBeNull();
    expect(decodeCursor(make('7'))).toBeNull();
  });
});
