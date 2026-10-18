import { defineConfig } from 'vitest/config';

// Two projects:
// - unit      runs anywhere, no database (npm test)
// - integration  needs the compose `test` profile database on :5433
//               (docker compose --profile test up -d --wait db-test),
//               and runs files sequentially so per-file truncation can't race.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
