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
import { PREMIUM_PLAN_ID } from '../../src/db/predefined.js';

// Account isolation end to end: an API key reaches only its own account's
// data, and a foreign tenant's resources are indistinguishable from
// nonexistent ones (404 masking).

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

describe('account isolation', () => {
  it('masks a foreign user identically to a nonexistent one (read + write + usage + history)', async () => {
    const mine = await bootstrapAccount(agent, 'DocuFlow');
    const rival = await bootstrapAccount(agent, 'Rival');
    const alice = await createUser(agent, mine.key, 'alice', PREMIUM_PLAN_ID);

    const randomId = '00000000-0000-4000-8000-000000000000';
    // Each probe builds its request fresh at await time (supertest Test
    // objects hold a handle to their ephemeral server - pre-building them
    // races the server lifecycle).
    const probes: Array<() => Promise<{ status: number; body: unknown }>> = [
      () => agent.get(`/v1/users/${alice.id}`).set('Authorization', `Bearer ${rival.key}`),
      () => agent.get(`/v1/users/${alice.id}/usage`).set('Authorization', `Bearer ${rival.key}`),
      () => agent.get(`/v1/users/${alice.id}/history`).set('Authorization', `Bearer ${rival.key}`),
      () =>
        agent
          .patch(`/v1/users/${alice.id}`)
          .set('Authorization', `Bearer ${rival.key}`)
          .send({ plan_id: PREMIUM_PLAN_ID }),
    ];

    // Every read/write against a foreign user answers 404,
    for (const probe of probes) {
      const foreign = await probe();
      expect(foreign.status).toBe(404);
      expect((foreign.body as { error: { message: string } }).error.message).toBe('user not found');
    }
    // with the same body as for a user that does not exist.
    const foreignGet = await agent
      .get(`/v1/users/${alice.id}`)
      .set('Authorization', `Bearer ${rival.key}`);
    const randomGet = await agent
      .get(`/v1/users/${randomId}`)
      .set('Authorization', `Bearer ${rival.key}`);
    expect(randomGet.status).toBe(404);
    expect(randomGet.body).toEqual(foreignGet.body);
  });

  it("hides a foreign account's custom plans: not listed, and patching one is 404", async () => {
    const mine = await bootstrapAccount(agent, 'DocuFlow');
    const rival = await bootstrapAccount(agent, 'Rival');
    const customPlanId = await createCustomPlan(agent, mine.key, 'SecretPlan', 'user', {
      monthly_allowance: 100,
      max_per_request: 10,
    });

    // Rival's catalog contains predefined plans only - not DocuFlow's custom one.
    const rivalPlans = await agent.get('/v1/plans').set('Authorization', `Bearer ${rival.key}`);
    expect(rivalPlans.status).toBe(200);
    expect(rivalPlans.body.items.some((p: { id: string }) => p.id === customPlanId)).toBe(false);

    const patch = await agent
      .patch(`/v1/plans/${customPlanId}`)
      .set('Authorization', `Bearer ${rival.key}`)
      .send({ rules: { monthly_allowance: 1 } });
    expect(patch.status).toBe(404);
    expect(patch.body.error.message).toBe('plan not found');

    // The owner can still patch it - the plan is intact.
    const ownPatch = await agent
      .patch(`/v1/plans/${customPlanId}`)
      .set('Authorization', `Bearer ${mine.key}`)
      .send({ rules: { monthly_allowance: 90, max_per_request: 10 } });
    expect(ownPatch.status).toBe(200);
  });

  it('scopes history and usage to the calling account', async () => {
    const mine = await bootstrapAccount(agent, 'DocuFlow');
    const rival = await bootstrapAccount(agent, 'Rival');
    const alice = await createUser(agent, mine.key, 'alice');
    await createUser(agent, rival.key, 'rival-user');

    const consume = await agent
      .post('/v1/consume')
      .set('Authorization', `Bearer ${mine.key}`)
      .send({ user_id: alice.id, request_id: 'iso-1', units: 5 });
    expect(consume.status).toBe(200);
    expect(consume.body.accepted).toBe(true);

    // Rival sees an empty ledger and zero usage - never DocuFlow's rows.
    const rivalHistory = await agent.get('/v1/history').set('Authorization', `Bearer ${rival.key}`);
    expect(rivalHistory.body.items).toHaveLength(0);
    const rivalUsage = await agent.get('/v1/usage').set('Authorization', `Bearer ${rival.key}`);
    expect(rivalUsage.body.used_units).toBe(0);

    const myHistory = await agent.get('/v1/history').set('Authorization', `Bearer ${mine.key}`);
    expect(myHistory.body.items).toHaveLength(1);
  });

  it('rejects a consume aimed at a foreign user (masked 404, nothing charged)', async () => {
    const mine = await bootstrapAccount(agent, 'DocuFlow');
    const rival = await bootstrapAccount(agent, 'Rival');
    const alice = await createUser(agent, mine.key, 'alice');

    const res = await agent
      .post('/v1/consume')
      .set('Authorization', `Bearer ${rival.key}`)
      .send({ user_id: alice.id, request_id: 'iso-c', units: 5 });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('user not found');

    const usage = await agent.get('/v1/usage').set('Authorization', `Bearer ${mine.key}`);
    expect(usage.body.used_units).toBe(0);
  });
});
