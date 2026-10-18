// Postgres error-code checks used to map database failures to client-facing
// responses. Services pre-validate the expected cases; these are the
// defensive mappings so a race (e.g. two concurrent inserts) never leaks
// out as a raw 500.
//
// Drizzle wraps driver errors in its own Error ("Failed query: ...") with
// the original pg error on `.cause`, so the code has to be searched along
// the cause chain 

export function isUniqueViolation(err: unknown): boolean {
  return findPgErrorCode(err) === '23505';
}

export function isForeignKeyViolation(err: unknown): boolean {
  return findPgErrorCode(err) === '23503';
}

function findPgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if ('code' in current) {
      const code = (current as { code?: unknown }).code;
      // pg error codes are five-character strings (23505, 23503, ...).
      if (typeof code === 'string' && /^\d{5}$/.test(code)) return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
