import { describe, expect, it } from 'vitest';
import { generateApiKey, sha256Hex } from '../../src/lib/keygen.js';

describe('api key generation', () => {
  it('produces um_-prefixed 46-char base64url keys', () => {
    const { key } = generateApiKey();
    expect(key).toMatch(/^um_[A-Za-z0-9_-]{43}$/);
  });

  it('never produces the same key twice', () => {
    const keys = new Set(Array.from({ length: 64 }, () => generateApiKey().key));
    expect(keys.size).toBe(64);
  });

  it('exposes a display prefix that is a proper prefix of the key', () => {
    const { key, keyPrefix } = generateApiKey();
    expect(key.startsWith(keyPrefix)).toBe(true);
    expect(keyPrefix).toHaveLength(12);
  });

  it('hashes deterministically - same input, same digest', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
