/**
 * The ApiError hierarchy. Every client-facing failure throws one of
 * these; the central error handler maps them to the JSON envelope
 * `{ error: { code, message, details? } }`. Anything else is a 500.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'a valid API key is required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ValidationError extends ApiError {
  constructor(message = 'invalid request', details?: unknown) {
    super(400, 'VALIDATION', message, details);
  }
}

export class NotFoundError extends ApiError {
  constructor(resource = 'resource') {
    // Foreign-tenant ids land here too - same answer as nonexistent ones.
    super(404, 'NOT_FOUND', `${resource} not found`);
  }
}

export class ForbiddenError extends ApiError {
  constructor(code: string, message: string) {
    super(403, code, message);
  }
}

export class ConflictError extends ApiError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
  }
}
