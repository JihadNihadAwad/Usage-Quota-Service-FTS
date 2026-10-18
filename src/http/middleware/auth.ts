import type { Db } from '../../db/client.js';
import type { AuthContext } from '../context.js';
import { UnauthorizedError } from '../errors.js';
import { verifyApiKey } from '../../services/apiKeys.js';
import type { Request, RequestHandler } from 'express';

/**
 * Bearer authentication. The presented key is hashed; the hash is looked up
 * via the unique index on api_keys.key_hash - O(1), and nothing about the
 * plaintext ever touches the database. Missing and invalid keys get the same
 * 401 shape (no oracle for which part was wrong).
 */
export function requireAuth(db: Db): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (header === undefined || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('missing Authorization: Bearer <key> header');
    }
    const presented = header.slice('Bearer '.length);
    if (!presented.startsWith('um_')) throw new UnauthorizedError('invalid API key');
    const ctx = await verifyApiKey(db, presented);
    if (ctx === null) throw new UnauthorizedError('invalid API key');
    req.auth = ctx;
    next();
  };
}

/**
 * Handler-side accessor. requireAuth runs before every protected route, so
 * this never throws in practice - it exists so the type system does not need
 * non-null assertions sprinkled through the routes.
 */
export function authCtx(req: Request): AuthContext {
  if (req.auth === undefined) throw new UnauthorizedError();
  return req.auth;
}
