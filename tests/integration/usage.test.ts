import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  api,
  bootstrapAccount,
  createCustomPlan,
  createUser,
  createTestPool,
  prepareDatabase,
  resetDatabase,
  type Agent,
} from './helpers.js';

// Usage reporting: consumed and remaining units for both the account and
// its users, including previous months, lazy counter rows, and plans
// without a monthly allowance.

const pool: Pool = createTestPool();
const agent: Agent = api(pool);

beforeAll(async () => {
  await prepareDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDatabase(pool);
});

async function getJson(path: string, key: string): Promise<Record<string, any>> {
  const res = await agent.get(path).set('Authorization', `Bearer ${key}`);
  expect(res.status).toBe(200);
  return res.body as Record<string, any>;
}

describe('usage endpoints', () => {
  it('reports zero usage for a fresh account (lazy rows: no counter row exists yet)', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const usage = await getJson('/v1/usage', key);
    expect(usage).toMatchObject({ used_units: 0, allowance: 10_000, remaining: 10_000 });
    expect(usage.month).toBe(`${new Date().toISOString().slice(0, 7)}-01`);
  });

  it('reflects consumption at both levels with zero-floor remaining', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const alice = await createUser(agent, key, 'alice');
    const consumed = await agent
      .post('/v1/consume')
      .set('Authorization', `Bearer ${key}`)
      .send({ user_id: alice.id, request_id: 'u-1', units: 10 });
    expect(consumed.body.accepted).toBe(true);

    expect(await getJson('/v1/usage', key)).toMatchObject({ used_units: 10, remaining: 9_990 });
    expect(await getJson(`/v1/users/${alice.id}/usage`, key)).toMatchObject({
      used_units: 10,
      remaining: 990,
    });
  });

  it('previous months report zero usage with their own intact allowance', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const alice = await createUser(agent, key, 'alice');
    await agent
      .post('/v1/consume')
      .set('Authorization', `Bearer ${key}`)
      .send({ user_id: alice.id, request_id: 'u-2', units: 10 })
      .expect(200);

    const oldAccount = await getJson('/v1/usage?month=2026-01', key);
    expect(oldAccount).toMatchObject({ month: '2026-01-01', used_units: 0, remaining: 10_000 });
    const oldUser = await getJson(`/v1/users/${alice.id}/usage?month=2026-01`, key);
    expect(oldUser).toMatchObject({ month: '2026-01-01', used_units: 0, remaining: 1_000 });

    // The current month is untouched by the query.
    expect(await getJson('/v1/usage', key)).toMatchObject({ used_units: 10 });
  });

  it('rejects a malformed or out-of-range month param with 400 + field details', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    for (const month of ['2026-13', '2026-00', '202610', 'not-a-month']) {
      const res = await agent.get(`/v1/usage?month=${month}`).set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    }
  });

  it('reports allowance/remaining null when the plan configures no monthly_allowance', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const planId = await createCustomPlan(agent, key, 'Capped', 'user', {
      monthly_request_cap: 5,
    });
    const alice = await createUser(agent, key, 'alice', planId);

    const usage = await getJson(`/v1/users/${alice.id}/usage`, key);
    expect(usage).toMatchObject({ used_units: 0, allowance: null, remaining: null });
  });
});
