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
import { PRO_PLAN_ID } from '../../src/db/predefined.js';

// Plan changes:
// - Plan changes apply to new requests after the update succeeds.
// - Switching plans preserves units already consumed; it does not grant a
//    fresh monthly allowance.
// - If a monthly allowance is reduced below existing usage, show zero
//    remaining allowance and reject further consumption at that level.
// - Changes must preserve past request history.
// Plus: editing a custom plan affects assigned users on their next request,
// and per-request rule snapshots keep old history explainable.

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

async function consume(
  key: string,
  userId: string,
  requestId: string,
  units: number,
): Promise<ReturnType<Agent['post']>> {
  return agent
    .post('/v1/consume')
    .set('Authorization', `Bearer ${key}`)
    .send({ user_id: userId, request_id: requestId, units });
}

describe('plan changes preserve usage and apply to new requests', () => {
  it('switching the account plan preserves consumed units (no fresh allowance)', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow'); // Starter 10,000
    const alice = await createUser(agent, key, 'alice');
    const consumed = await consume(key, alice.id, 'pc-1', 10);
    expect(consumed.body.accepted).toBe(true);

    const patch = await agent
      .patch('/v1/account')
      .set('Authorization', `Bearer ${key}`)
      .send({ account_plan_id: PRO_PLAN_ID });
    expect(patch.status).toBe(200);

    const usage = await getJson('/v1/usage', key);
    expect(usage).toMatchObject({ used_units: 10, allowance: 100_000, remaining: 99_990 });
  });

  it('downgrading below current usage: zero remaining, further consumption rejected at that level', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const bigPlan = await createCustomPlan(agent, key, 'Big', 'user', {
      monthly_allowance: 100,
      max_per_request: 100,
    });
    const alice = await createUser(agent, key, 'alice', bigPlan);
    await consume(key, alice.id, 'pc-2', 80);

    const smallPlan = await createCustomPlan(agent, key, 'Small', 'user', {
      monthly_allowance: 50,
      max_per_request: 100,
    });
    const switchRes = await agent
      .patch(`/v1/users/${alice.id}`)
      .set('Authorization', `Bearer ${key}`)
      .send({ plan_id: smallPlan });
    expect(switchRes.status).toBe(200);

    // Zero-floor: remaining is 0, never negative; usage is preserved at 80.
    const usage = await getJson(`/v1/users/${alice.id}/usage`, key);
    expect(usage).toMatchObject({ used_units: 80, allowance: 50, remaining: 0 });

    const attempt = await consume(key, alice.id, 'pc-3', 1);
    expect(attempt.body).toMatchObject({
      accepted: false,
      units_consumed: 0,
      reason: { level: 'user', rule: 'monthly_allowance' },
    });

    // Upgrade: allowance becomes available again, usage still preserved.
    const upgradeRes = await agent
      .patch(`/v1/users/${alice.id}`)
      .set('Authorization', `Bearer ${key}`)
      .send({ plan_id: bigPlan });
    expect(upgradeRes.status).toBe(200);
    const usageAfter = await getJson(`/v1/users/${alice.id}/usage`, key);
    expect(usageAfter).toMatchObject({ used_units: 80, allowance: 100, remaining: 20 });
    const okAgain = await consume(key, alice.id, 'pc-4', 20);
    expect(okAgain.body.accepted).toBe(true);
  });

  it('keeps past request history intact across plan changes', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const planA = await createCustomPlan(agent, key, 'A', 'user', {
      monthly_allowance: 100,
      max_per_request: 100,
    });
    const alice = await createUser(agent, key, 'alice', planA);
    await consume(key, alice.id, 'pc-5', 40);
    await agent
      .patch(`/v1/users/${alice.id}`)
      .set('Authorization', `Bearer ${key}`)
      .send({ plan_id: planA }); // no-op switch: same plan

    const before = await getJson('/v1/history?limit=100', key);
    expect(before.items).toHaveLength(1);

    // Switch the account plan and the user plan; history is untouched.
    await agent
      .patch('/v1/account')
      .set('Authorization', `Bearer ${key}`)
      .send({ account_plan_id: PRO_PLAN_ID });
    await consume(key, alice.id, 'pc-6', 5);

    const after = await getJson('/v1/history?limit=100', key);
    expect(after.items).toHaveLength(2);
    expect(after.items.map((i: { request_id: string }) => i.request_id)).toContain('pc-5');
  });

  it('editing a custom plan affects assigned users on their next request', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const planId = await createCustomPlan(agent, key, 'Editable', 'user', {
      monthly_allowance: 10,
      max_per_request: 5,
    });
    const alice = await createUser(agent, key, 'alice', planId);

    const underOriginal = await consume(key, alice.id, 'pc-7', 5);
    expect(underOriginal.body.accepted).toBe(true);

    const edit = await agent
      .patch(`/v1/plans/${planId}`)
      .set('Authorization', `Bearer ${key}`)
      .send({ rules: { monthly_allowance: 20, max_per_request: 20 } });
    expect(edit.status).toBe(200);

    // 15 units would have been impossible under the old plan (10/mo, 5/req);
    // under the edited rules it is accepted - no redeploy, no reassignment.
    const underEdited = await consume(key, alice.id, 'pc-8', 15);
    expect(underEdited.body.accepted).toBe(true);
    expect(underEdited.body.evaluated.user_rules).toEqual({
      monthly_allowance: 20,
      max_per_request: 20,
    });
  });

  it('per-request rule snapshots keep history explainable after edits (checked in the ledger)', async () => {
    const { key, accountId } = await bootstrapAccount(agent, 'DocuFlow');
    const planId = await createCustomPlan(agent, key, 'Snapshotted', 'user', {
      monthly_allowance: 10,
      max_per_request: 10,
    });
    const alice = await createUser(agent, key, 'alice', planId);
    await consume(key, alice.id, 'pc-9', 5);

    await agent
      .patch(`/v1/plans/${planId}`)
      .set('Authorization', `Bearer ${key}`)
      .send({ rules: { monthly_allowance: 20, max_per_request: 20 } });
    await consume(key, alice.id, 'pc-10', 5);

    // Direct ledger check: each row carries the rules it was judged under.
    const { rows } = await pool.query(
      'select request_id, user_rules from requests where account_id = $1 order by id',
      [accountId],
    );
    expect(rows).toEqual([
      { request_id: 'pc-9', user_rules: { monthly_allowance: 10, max_per_request: 10 } },
      { request_id: 'pc-10', user_rules: { monthly_allowance: 20, max_per_request: 20 } },
    ]);
  });
});
