import { defineConfig } from 'vitest/config';

// Unit tests only for now; the db-backed projects come with the compose stack
// (unit + integration against the compose `test` profile DB on :5433).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
