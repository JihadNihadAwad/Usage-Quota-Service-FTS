import { z } from 'zod';

// Fail-fast boot: any malformed env var kills the process with a clear
// zod error instead of surfacing as weird behavior later (plan §4).
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Parsed now so misconfiguration
  // fails at boot, not mid-transaction.
  DATABASE_URL: z.string().min(1).default('postgres://postgres:postgres@localhost:5432/fts'),
  // Used by the example client.
  CLIENT_PORT: z.coerce.number().int().positive().default(3001),
  USAGE_API_URL: z.url().default('http://localhost:3000/v1'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  return EnvSchema.parse(process.env);
}
