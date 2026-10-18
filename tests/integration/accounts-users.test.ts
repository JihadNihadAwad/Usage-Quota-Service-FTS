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
import {
  BASIC_PLAN_ID,
  PREMIUM_PLAN_ID,
  PRO_PLAN_ID,
  STARTER_PLAN_ID,
} from '../../src/db/predefined.js';

// Account and user management: creating an account issues its first API
// key; users are registered under the account, and their plans can be
// assigned or changed.

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

describe('account bootstrap', () => {
  it('issues a single-use API key with the documented shape and defaults to Starter', async () => {
    const res = await agent.post('/v1/accounts').send({ name: 'Acme' });
    expect(res.status).toBe(201);
    expect(res.body.account).toMatchObject({
      name: 'Acme',
      plan: { id: STARTER_PLAN_ID, name: 'Starter', predefined: true },
    });
    expect(res.body.api_key.key).toMatch(/^um_[A-Za-z0-9_-]{43}$/);
    expect(res.body.api_key.key_prefix).toHaveLength(12);

    // The key works immediately.
    const me = await agent
      .get('/v1/account')
      .set('Authorization', `Bearer ${res.body.api_key.key}`);
    expect(me.body.id).toBe(res.body.account.id);
  });

  it('accepts an explicit predefined account plan at bootstrap', async () => {
    const res = await agent
      .post('/v1/accounts')
      .send({ name: 'ProFromBirth', account_plan_id: PRO_PLAN_ID });
    expect(res.body.account.plan.name).toBe('Pro');
  });

  it('rejects a user-scoped plan as the account plan', async () => {
    const res = await agent
      .post('/v1/accounts')
      .send({ name: 'BadScope', account_plan_id: BASIC_PLAN_ID });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PLAN_SCOPE_MISMATCH');
  });
});

describe('user management', () => {
  it('registers users with per-account external ids and a default Basic plan', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const alice = await agent
      .post('/v1/users')
      .set('Authorization', `Bearer ${key}`)
      .send({ external_id: 'alice' });
    expect(alice.status).toBe(201);
    expect(alice.body).toMatchObject({
      external_id: 'alice',
      plan: { id: BASIC_PLAN_ID, name: 'Basic' },
    });

    // Two accounts may independently use the same external id (external
    // ids are namespaced per account).
    const rival = await bootstrapAccount(agent, 'Rival');
    const theirAlice = await agent
      .post('/v1/users')
      .set('Authorization', `Bearer ${rival.key}`)
      .send({ external_id: 'alice' });
    expect(theirAlice.status).toBe(201);
    expect(theirAlice.body.id).not.toBe(alice.body.id);
  });

  it('rejects a duplicate external_id within the same account (409)', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    await createUser(agent, key, 'alice');
    const dup = await agent
      .post('/v1/users')
      .set('Authorization', `Bearer ${key}`)
      .send({ external_id: 'alice' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('USER_ALREADY_EXISTS');
  });

  it("lists the account's users and assigns/changes plans via PATCH", async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const alice = await createUser(agent, key, 'alice');
    const bob = await createUser(agent, key, 'bob', PREMIUM_PLAN_ID);

    const list = await agent.get('/v1/users').set('Authorization', `Bearer ${key}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items.map((u: { external_id: string }) => u.external_id).sort()).toEqual([
      'alice',
      'bob',
    ]);

    const customPlanId = await createCustomPlan(agent, key, 'Gold', 'user', {
      monthly_allowance: 500,
      max_per_request: 50,
    });
    const patched = await agent
      .patch(`/v1/users/${alice.id}`)
      .set('Authorization', `Bearer ${key}`)
      .send({ plan_id: customPlanId });
    expect(patched.status).toBe(200);
    expect(patched.body.plan.name).toBe('Gold');

    const reread = await agent.get(`/v1/users/${alice.id}`).set('Authorization', `Bearer ${key}`);
    expect(reread.body.plan.id).toBe(customPlanId);

    // bob's assignment is untouched.
    const bobReread = await agent.get(`/v1/users/${bob.id}`).set('Authorization', `Bearer ${key}`);
    expect(bobReread.body.plan.name).toBe('Premium');
  });

  it('switches the account plan via PATCH /account', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const res = await agent
      .patch('/v1/account')
      .set('Authorization', `Bearer ${key}`)
      .send({ account_plan_id: PRO_PLAN_ID });
    expect(res.status).toBe(200);
    expect(res.body.plan.name).toBe('Pro');

    const me = await agent.get('/v1/account').set('Authorization', `Bearer ${key}`);
    expect(me.body.plan.id).toBe(PRO_PLAN_ID);
  });
});
