/**
 * Request context attached by the auth middleware. The account is ALWAYS
 * derived from the verified API key - never from caller-supplied ids - so
 * every downstream query stays inside one account.
 */
export interface AuthContext {
  accountId: string;
  keyId: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}
