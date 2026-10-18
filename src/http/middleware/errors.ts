import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../../lib/logger.js';
import { isUniqueViolation } from '../../lib/pg-errors.js';
import { ApiError, ValidationError } from '../errors.js';
import { issuesToDetails } from './validate.js';

/**
 * The single exit point for failures. Known ApiErrors map to their status +
 * the JSON envelope; anything unexpected is logged (with the request id for
 * correlation) and becomes an opaque 500 - internals never leak.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    const envelope: { code: string; message: string; details?: unknown } = {
      code: err.code,
      message: err.message,
    };
    if (err.details !== undefined) envelope.details = err.details;
    res.status(err.status).json({ error: envelope });
    return;
  }

  // Defensive: a zod error that escaped route validation (should not happen).
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'VALIDATION', message: 'invalid request', details: issuesToDetails(err) },
    });
    return;
  }

  // Defensive: a uniqueness race that pre-validation did not catch.
  if (isUniqueViolation(err)) {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'resource already exists' } });
    return;
  }

  // Malformed JSON from the body parser (carries status 400).
  if (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status?: unknown }).status === 400
  ) {
    res
      .status(400)
      .json({ error: { code: 'INVALID_JSON', message: 'request body is not valid JSON' } });
    return;
  }

  logger.error('unhandled error', {
    requestId: res.locals.requestId,
    error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
  });
  res.status(500).json({ error: { code: 'INTERNAL', message: 'internal server error' } });
};
