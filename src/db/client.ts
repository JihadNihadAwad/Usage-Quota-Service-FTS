import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadEnv } from '../config/env.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: Db | undefined;

/** Lazily-created process-wide pg pool (pg connects on first query, not on
 *  construction, so importing this module in tests without a database is safe). */
export function getPool(): Pool {
  if (!pool) {
    const env = loadEnv();
    pool = new Pool({ connectionString: env.DATABASE_URL, max: env.POOL_MAX });
    // When the database dies or restarts (e.g. `docker compose restart db`),
    // pg surfaces it as an 'error' event on the pool. Without a listener,
    // Node treats it as an uncaught exception and the process crashes -
    // taking /healthz down with it.
    // The handler logs; queries fail cleanly; the pool reconnects on demand.
    pool.on('error', (err: Error) => {
      console.error('[db] pool error (connection lost?):', err.message);
    });
  }
  return pool;
}

/** The app-wide drizzle instance bound to the schema. */
export function getDb(): Db {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

/** Close the pool (dev scripts + tests). Safe to call repeatedly. */
export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = undefined;
    db = undefined;
    await closing.end();
  }
}
