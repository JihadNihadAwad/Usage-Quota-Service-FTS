import { defineConfig } from 'drizzle-kit';

// `npm run db:generate` turns src/db/schema.ts into committed SQL under
// src/db/migrations. Runtime application happens via
// src/db/migrate.ts (drizzle's programmatic migrator).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
});
