import express, { type ErrorRequestHandler, type RequestHandler } from 'express';

// Minimal but real — the error envelope shape `{ error: { code, message } }`
// is final; everything else (auth, routes, request-logging) comes with the API layer.

const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'resource not found' } });
};

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Express 5 forwards rejected promises from async handlers here natively.
  console.error('[http] unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'internal server error' } });
};

export function createApp() {
  const app = express();
  app.use(express.json());

  // Liveness: process is up. Readiness wires up with the database.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/readyz', (_req, res) => {
    res.status(503).json({ status: 'not-ready', reason: 'database not wired yet' });
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
