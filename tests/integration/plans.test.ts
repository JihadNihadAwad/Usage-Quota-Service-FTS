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

// Custom plans: create/view/update with scope enforcement, predefined
// plans read-only, and several users may share one plan definition while
// keeping separate usage totals.

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

describe('plan catalog and scopes', () => {
  it("lists the predefined catalog plus the account's own custom plans, filterable by scope", async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    await createCustomPlan(agent, key, 'Gold', 'user', {
      monthly_allowance: 500,
      max_per_request: 50,
    });
    await createCustomPlan(agent, key, 'Bulk', 'account', {
      monthly_allowance: 5000,
      max_per_request: 500,
    });

    const all = await agent.get('/v1/plans').set('Authorization', `Bearer ${key}`);
    const names = all.body.items.map((p: { name: string }) => p.name).sort();
    expect(names).toEqual(['Basic', 'Bulk', 'Gold', 'Premium', 'Pro', 'Starter']);

    const userScoped = await agent
      .get('/v1/plans?scope=user')
      .set('Authorization', `Bearer ${key}`);
    expect(userScoped.body.items.map((p: { name: string }) => p.name).sort()).toEqual([
      'Basic',
      'Gold',
      'Premium',
    ]);

    const predefined = (all.body.items as Array<{ name: string; predefined: boolean }>).filter(
      (p) => ['Starter', 'Pro', 'Basic', 'Premium'].includes(p.name),
    );
    expect(predefined.every((p) => p.predefined)).toBe(true);
    const custom = (all.body.items as Array<{ name: string; predefined: boolean }>).filter((p) =>
      ['Gold', 'Bulk'].includes(p.name),
    );
    expect(custom.every((p) => !p.predefined)).toBe(true);
  });

  it('rejects duplicate names per scope with 409, but allows the same name in the other scope', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    await createCustomPlan(agent, key, 'Duo', 'user', {
      monthly_allowance: 100,
      max_per_request: 10,
    });

    const dup = await agent
      .post('/v1/plans')
      .set('Authorization', `Bearer ${key}`)
      .send({ name: 'Duo', scope: 'user', rules: { monthly_allowance: 200, max_per_request: 20 } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PLAN_NAME_TAKEN');

    const otherScope = await agent
      .post('/v1/plans')
      .set('Authorization', `Bearer ${key}`)
      .send({
        name: 'Duo',
        scope: 'account',
        rules: { monthly_allowance: 2000, max_per_request: 200 },
      });
    expect(otherScope.status).toBe(201);
  });

  it('a custom plan may reuse a predefined plan name (separate namespace)', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const res = await agent
      .post('/v1/plans')
      .set('Authorization', `Bearer ${key}`)
      .send({
        name: 'Starter',
        scope: 'user',
        rules: { monthly_allowance: 5, max_per_request: 5 },
      });
    expect(res.status).toBe(201);
    expect(res.body.predefined).toBe(false);
  });
});

describe('plan updates', () => {
  it('updates own custom plans (name and rules); predefined are 403 PLAN_IMMUTABLE', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const planId = await createCustomPlan(agent, key, 'Gold', 'user', {
      monthly_allowance: 500,
      max_per_request: 50,
    });

    const patched = await agent
      .patch(`/v1/plans/${planId}`)
      .set('Authorization', `Bearer ${key}`)
      .send({ name: 'Gold Plus', rules: { monthly_allowance: 600, max_per_request: 60 } });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      name: 'Gold Plus',
      rules: { monthly_allowance: 600, max_per_request: 60 },
    });

    for (const predefinedId of [STARTER_PLAN_ID, PRO_PLAN_ID, BASIC_PLAN_ID, PREMIUM_PLAN_ID]) {
      const attempt = await agent
        .patch(`/v1/plans/${predefinedId}`)
        .set('Authorization', `Bearer ${key}`)
        .send({ rules: { monthly_allowance: 1 } });
      expect(attempt.status).toBe(403);
      expect(attempt.body.error.code).toBe('PLAN_IMMUTABLE');
    }
  });

  it('enforces scope at assignment in both directions', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const accountPlan = await createCustomPlan(agent, key, 'Shared', 'account', {
      monthly_allowance: 5000,
      max_per_request: 500,
    });
    const alice = await createUser(agent, key, 'alice');

    const toUser = await agent
      .patch(`/v1/users/${alice.id}`)
      .set('Authorization', `Bearer ${key}`)
      .send({ plan_id: accountPlan });
    expect(toUser.status).toBe(400);
    expect(toUser.body.error.code).toBe('PLAN_SCOPE_MISMATCH');

    const toAccount = await agent
      .patch('/v1/account')
      .set('Authorization', `Bearer ${key}`)
      .send({ account_plan_id: BASIC_PLAN_ID });
    expect(toAccount.status).toBe(400);
    expect(toAccount.body.error.code).toBe('PLAN_SCOPE_MISMATCH');
  });
});

describe('shared plan definition, separate usage totals', () => {
  it('two users on the same plan keep individual allowances while sharing the account pool', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow'); // Starter 10,000/mo
    const sharedPlanId = await createCustomPlan(agent, key, 'Team', 'user', {
      monthly_allowance: 100,
      max_per_request: 50,
    });
    const u1 = await createUser(agent, key, 'u1', sharedPlanId);
    const u2 = await createUser(agent, key, 'u2', sharedPlanId);

    // u1 spends most of their allowance; u2 is untouched.
    const first = await agent
      .post('/v1/consume')
      .set('Authorization', `Bearer ${key}`)
      .send({ user_id: u1.id, request_id: 'shared-1', units: 40 });
    expect(first.body.accepted).toBe(true);

    const u1Usage = await agent
      .get(`/v1/users/${u1.id}/usage`)
      .set('Authorization', `Bearer ${key}`);
    const u2Usage = await agent
      .get(`/v1/users/${u2.id}/usage`)
      .set('Authorization', `Bearer ${key}`);
    expect(u1Usage.body).toMatchObject({ used_units: 40, remaining: 60, allowance: 100 });
    expect(u2Usage.body).toMatchObject({ used_units: 0, remaining: 100, allowance: 100 });

    // u2's request is judged by u2's own counters (u1's burn doesn't affect it).
    const second = await agent
      .post('/v1/consume')
      .set('Authorization', `Bearer ${key}`)
      .send({ user_id: u2.id, request_id: 'shared-2', units: 45 });
    expect(second.body.accepted).toBe(true);

    // The account, meanwhile, accumulated both.
    const accountUsage = await agent.get('/v1/usage').set('Authorization', `Bearer ${key}`);
    expect(accountUsage.body.used_units).toBe(85);
  });
});
