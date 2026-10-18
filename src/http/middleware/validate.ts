import type { RequestHandler } from 'express';
import { ZodError, type ZodType } from 'zod';
import { ValidationError } from '../errors.js';

/**
 * Route-level validation: parses and REPLACES req.body / req.query /
 * req.params with the zod-parsed values, so handlers work with known shapes.
 * Failures become ValidationError (400) with per-field details.
 *
 * req.query needs defineProperty: Express 5 declares it as a prototype
 * getter, so plain assignment throws "which has only a getter".
 */
export function validate(schemas: {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}): RequestHandler {
  return (req, _res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) {
        Object.defineProperty(req, 'query', {
          value: schemas.query.parse(req.query),
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
      if (schemas.params) {
        Object.defineProperty(req, 'params', {
          value: schemas.params.parse(req.params),
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(new ValidationError('invalid request', issuesToDetails(err)));
      } else {
        next(err);
      }
    }
  };
}

export function issuesToDetails(err: ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}
