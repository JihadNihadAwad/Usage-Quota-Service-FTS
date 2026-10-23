import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closePool, getDb } from './client.js';

// Under tsx this resolves to src/db/migrations. tsc does not copy .sql files
// into dist, so the Dockerfile copies the committed migrations to
// dist/db/migrations - where the same fallback resolves from the compiled
// container entrypoint (dist/start.js). MIGRATIONS_DIR overrides both.
const migrationsFolder =
  process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('./migrations', import.meta.url));

async function main(): Promise<void> {
  await migrate(getDb(), { migrationsFolder });
  console.log(`[migrate] schema up to date (from ${migrationsFolder})`);
}

main()
  .then(() => closePool())
  .catch((err: unknown) => {
    console.error('[migrate] failed:', err);
    process.exitCode = 1;
    return closePool();
  });
