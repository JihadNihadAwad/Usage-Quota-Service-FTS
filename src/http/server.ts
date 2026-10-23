import { drizzle } from 'drizzle-orm/node-postgres';
import express, { Router, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import * as schema from '../db/schema.js';
import { getPool, type Db } from '../db/client.js';
import { setLogLevel } from '../lib/logger.js';
import { loadEnv } from '../config/env.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/errors.js';
import { requestLogging } from './middleware/request-logging.js';
import { accountRoutes, publicAccountRoutes } from './routes/accounts.js';
import { consumeRoutes } from './routes/consume.js';
import { historyRoutes } from './routes/history.js';
import { planRoutes } from './routes/plans.js';
import { usageRoutes } from './routes/usage.js';
import { userRoutes } from './routes/users.js';

export interface AppDeps {
  /** Postgres pool backing every db query. Injectable so unit tests stay
   *  database-free (stub pool for readiness, no db touch otherwise). */
  pool?: Pool;
}

export function createApp({ pool = getPool() }: AppDeps = {}) {
  setLogLevel(loadEnv().LOG_LEVEL);
  const db: Db = drizzle(pool, { schema });

  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogging());
  app.use(express.json({ limit: '1mb' }));

  // Liveness: the process is up, nothing more.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Readiness: the process and its database are both usable.
  app.get('/readyz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.status(200).json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not-ready' });
    }
  });

  const v1 = Router();

  // Unauthenticated bootstrap - mounted before the auth gate,
  // the ONLY unauthenticated mutation in the API.
  v1.use(publicAccountRoutes(db));

  // Everything below requires a valid API key; the account identity comes
  // from the key, never from caller-supplied ids.
  v1.use(requireAuth(db));

  v1.use(accountRoutes(db));
  v1.use(userRoutes(db));
  v1.use(planRoutes(db));
  v1.use(usageRoutes(db));
  v1.use(historyRoutes(db));
  v1.use(consumeRoutes(db));

  app.use('/v1', v1);

  const notFound: RequestHandler = (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'resource not found' } });
  };
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
