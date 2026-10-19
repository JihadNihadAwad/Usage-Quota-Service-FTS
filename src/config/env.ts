import { z } from 'zod';

// Fail-fast boot: any malformed env var kills the process with a clear
// zod error instead of surfacing as weird behavior later.
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Consumed by the db layer (drizzle/pg); parsed here so misconfiguration
  // fails at boot, not mid-transaction.
  DATABASE_URL: z.string().min(1).default('postgres://postgres:postgres@localhost:5432/fts'),
  // Postgres pool size. pg's own default is 10; declaring it makes the api's
  // connection ceiling a visible knob instead of a hidden library default
  // - the 8-account scaling stage measures exactly where it bites
  // (performance/results).
  POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // Used by the example client (client/server.ts).
  CLIENT_PORT: z.coerce.number().int().positive().default(3001),
  USAGE_API_URL: z.url().default('http://localhost:3000/v1'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  return EnvSchema.parse(process.env);
}
