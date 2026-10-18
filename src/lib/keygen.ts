import { createHash, randomBytes } from 'node:crypto';

export const KEY_PREFIX_LENGTH = 12;

/**
 * API keys: `um_` + 32 random bytes in base64url (43 chars, ~256 bits of
 * entropy). Only the SHA-256 hash is stored
 * - a fast hash is correct here precisely because the input is unguessable,
 * unlike a human password. The plaintext exists exactly once, in the creation
 * response.
 */
export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = `um_${randomBytes(32).toString('base64url')}`;
  return { key, keyHash: sha256Hex(key), keyPrefix: key.slice(0, KEY_PREFIX_LENGTH) };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
