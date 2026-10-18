import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { getPool } from '../db/client.js';

export interface AppDeps {
  /** Postgres pool backing the readiness check. Injectable so unit tests
   *  can pass a dead or stubbed pool and stay database-free. */
  pool?: Pool;
}

export function createApp({ pool = getPool() }: AppDeps = {}) {
  const app = express();
  app.use(express.json());

  // Liveness: the process is up, nothing more.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Readiness: the process AND its one dependency are usable.
  app.get('/readyz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.status(200).json({ status: 'ready' });
    } catch (err: unknown) {
      console.error('[readyz] database not reachable:', err instanceof Error ? err.message : err);
      res.status(503).json({ status: 'not-ready' });
    }
  });

  const notFound: RequestHandler = (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'resource not found' } });
  };

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    // Express 5 forwards rejected promises from async handlers here natively.
    console.error('[http] unhandled error:', err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal server error' } });
  };

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
