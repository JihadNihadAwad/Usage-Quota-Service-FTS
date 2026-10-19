import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import { Pool } from 'pg';
import * as schema from '../../src/db/schema.js';
import { seedPredefinedPlans } from '../../src/db/seed.js';
import { createApp } from '../../src/http/server.js';
import { STARTER_PLAN_ID } from '../../src/db/predefined.js';

// supertest attaches per-request listeners to its ephemeral server; the
// concurrency storms run 50 requests in flight, past the default ceiling.
EventEmitter.defaultMaxListeners = 100;

export type Agent = ReturnType<typeof request>;
export type TestDb = NodePgDatabase<typeof schema>;

// The integration database is the compose `test` profile (port 5433, database
// fts_test) - never the dev database on 5432.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/fts_test';

export function createTestPool(): Pool {
  // max: 40 because the concurrency tests need headroom OVER the storm they
  // create: the plan-flip race test holds ~30 consume transactions in flight
  // while sending its own control calls (the plan PATCHes). With pg's default
  // of 10, those control calls would queue BEHIND the storm's transactions
  // and land only after it drained - silently destroying the "mid-storm"
  // property the test exists to create. 40 leaves room for storm + controls.
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 40 });
  // Same discipline as src/db/client.ts: an unhandled pool error kills the
  // process.
  pool.on('error', (err: Error) => console.error('[test-db] pool error:', err.message));
  return pool;
}

/** Apply committed migrations (idempotent - a no-op after the first run). */
export async function prepareDatabase(pool: Pool): Promise<void> {
  await migrate(drizzle(pool, { schema }), {
    migrationsFolder: fileURLToPath(new URL('../../src/db/migrations', import.meta.url)),
  });
}

/** Pristine database for one test: every table truncated, predefined plans re-seeded. */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(
    'truncate table requests, user_usage, account_usage, api_keys, users, accounts, plans restart identity cascade',
  );
  await seedPredefinedPlans(drizzle(pool, { schema }));
}

/** A supertest agent bound to a fresh app using the given pool. */
export function api(pool: Pool): Agent {
  return request(createApp({ pool }));
}

export interface TestAccount {
  accountId: string;
  key: string;
}

export async function bootstrapAccount(
  agent: Agent,
  name: string,
  accountPlanId: string = STARTER_PLAN_ID,
): Promise<TestAccount> {
  const res = await agent.post('/v1/accounts').send({ name, account_plan_id: accountPlanId });
  if (res.status !== 201) {
    throw new Error(`account bootstrap failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { accountId: res.body.account.id, key: res.body.api_key.key };
}

export async function createUser(
  agent: Agent,
  key: string,
  externalId: string,
  planId?: string,
): Promise<{ id: string }> {
  const res = await agent
    .post('/v1/users')
    .set('Authorization', `Bearer ${key}`)
    .send(
      planId === undefined
        ? { external_id: externalId }
        : { external_id: externalId, plan_id: planId },
    );
  if (res.status !== 201) {
    throw new Error(`user creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.id };
}

export async function createCustomPlan(
  agent: Agent,
  key: string,
  name: string,
  scope: 'account' | 'user',
  rules: Record<string, number>,
): Promise<string> {
  const res = await agent
    .post('/v1/plans')
    .set('Authorization', `Bearer ${key}`)
    .send({ name, scope, rules });
  if (res.status !== 201) {
    throw new Error(`plan creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.id;
}
