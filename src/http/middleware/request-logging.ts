import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { logger } from '../../lib/logger.js';

/**
 * Assigns a request id (echoed back as x-request-id) and logs one JSON line
 * per completed request: method, path, status, duration. The id threads
 * through to error logs for correlation.
 */
export function requestLogging(): RequestHandler {
  return (req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    const start = performance.now();
    res.on('finish', () => {
      logger.info('request', {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round((performance.now() - start) * 10) / 10,
      });
    });
    next();
  };
}
