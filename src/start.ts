import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadEnv } from './config/env.js';
import { closePool, getDb, getPool } from './db/client.js';
import { seedPredefinedPlans } from './db/seed.js';
import { createApp } from './http/server.js';
import { logger, setLogLevel } from './lib/logger.js';

/**
 * Container entrypoint (`node dist/start.js`): one process does everything
 * needed at startup - apply the committed migrations, seed the predefined
 * plans (both idempotent), then listen. `docker compose up` is therefore
 * the only setup step; no manual init.
 *
 * Dev entry (`npm run dev`, src/index.ts) skips migration/seeding and assumes
 * `npm run migrate && npm run seed` were run against the dev database.
 *
 * All pool creation flows through getPool() - the guarded pool with the pg
 * 'error' handler, so a database restart degrades readiness instead of
 * killing the process.
 */

const migrationsFolder =
  process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('./db/migrations', import.meta.url));

async function main(): Promise<void> {
  const env = loadEnv();
  setLogLevel(env.LOG_LEVEL);

  await migrate(getDb(), { migrationsFolder });
  const seedReport = await seedPredefinedPlans();
  logger.info('startup complete', {
    migrationsFolder,
    seeded: seedReport,
  });

  const app = createApp({ pool: getPool() });
  const server = app.listen(env.PORT, () => {
    logger.info('api listening', { port: env.PORT, logLevel: env.LOG_LEVEL });
  });

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    server.close(() => {
      closePool()
        .catch((err: unknown) => {
          console.error('[start] error closing pool:', err);
        })
        .finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[start] fatal startup error:', err);
  process.exit(1);
});
