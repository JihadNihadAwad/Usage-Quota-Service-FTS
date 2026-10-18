// Postgres error-code checks used to map database failures to client-facing
// responses. Services pre-validate the expected cases; these are the
// defensive mappings so a race (e.g. two concurrent inserts) never leaks
// out as a raw 500.
//
// Drizzle wraps driver errors in its own Error ("Failed query: ...") with
// the original pg error on `.cause`, so fields have to be searched along
// the cause chain.

interface PgErrorInfo {
  code?: string;
  constraint?: string;
}

function pgErrorInfo(err: unknown): PgErrorInfo {
  const info: PgErrorInfo = {};
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if (info.code === undefined && 'code' in current) {
      const code = (current as { code?: unknown }).code;
      // pg error codes are five-character strings (23505, 23503, ...).
      if (typeof code === 'string' && /^\d{5}$/.test(code)) info.code = code;
    }
    if (info.constraint === undefined && 'constraint' in current) {
      const constraint = (current as { constraint?: unknown }).constraint;
      if (typeof constraint === 'string') info.constraint = constraint;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return info;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgErrorInfo(err).code === '23505';
}

export function isForeignKeyViolation(err: unknown): boolean {
  return pgErrorInfo(err).code === '23503';
}

/** Which unique constraint fired, when err is a unique violation. */
export function uniqueViolationConstraint(err: unknown): string | null {
  const info = pgErrorInfo(err);
  return info.code === '23505' && info.constraint !== undefined ? info.constraint : null;
}
