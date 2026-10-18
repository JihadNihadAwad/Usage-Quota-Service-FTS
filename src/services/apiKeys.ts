import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { sha256Hex } from '../lib/keygen.js';

export interface ApiKeyIdentity {
  accountId: string;
  keyId: string;
}

/** Hash-lookup of a presented key. Returns the account it belongs to, or
 *  null when no key matches (invalid and missing are indistinguishable). */
export async function verifyApiKey(db: Db, presentedKey: string): Promise<ApiKeyIdentity | null> {
  const [row] = await db
    .select({ id: apiKeys.id, accountId: apiKeys.accountId })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, sha256Hex(presentedKey)))
    .limit(1);
  return row === undefined ? null : { accountId: row.accountId, keyId: row.id };
}
