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

  it('a plan flip landing mid-storm never corrupts accounting (every request judged by exactly one rule set)', async () => {
    const { key, accountId } = await bootstrapAccount(agent, 'DocuFlow');
    // Two account plans with distinguishable allowances.
    const tight = await createCustomPlan(agent, key, 'FlipTight', 'account', {
      monthly_allowance: 40,
      max_per_request: 100,
    });
    const loose = await createCustomPlan(agent, key, 'FlipLoose', 'account', {
      monthly_allowance: 60,
      max_per_request: 100,
    });
    const patchTo = async (planId: string) =>
      agent
        .patch('/v1/account')
        .set('Authorization', `Bearer ${key}`)
        .send({ account_plan_id: planId });
    await patchTo(tight);

    const alice = await createUser(agent, key, 'alice');
    const drain = async () => {
      const usage = await getJson('/v1/usage', key);
      return usage;
    };
    expect((await drain()).used_units).toBe(0);

    // 30 concurrent requests of 2 units (60 demanded vs 40 tight / 60 loose),
    // with the account plan flipped tight -> loose -> tight while the storm
    // is in flight. Whatever interleaving happens, each request must be
    // judged atomically under ONE of the two rule sets.
    const storm = Promise.all(
      Array.from({ length: 30 }, (_, i) => consume(key, alice.id, `flip-${i}`, 2)),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const flip1 = await patchTo(loose);
    expect(flip1.status).toBe(200);
    const flip2 = await patchTo(tight);
    expect(flip2.status).toBe(200);
    const results = await storm;

    for (const res of results) expect(res.status).toBe(200);
    const accepted = results.filter((r) => r.body.accepted === true);
    const used = accepted.reduce((sum, r) => sum + r.body.units_consumed, 0);

    // Global invariants: the API totals equal the sum of accepted charges.
    const usage = await getJson('/v1/usage', key);
    expect(usage.used_units).toBe(used);
    const userUsage = await getJson(`/v1/users/${alice.id}/usage`, key);
    expect(userUsage.used_units).toBe(used);

    // The strong check, straight from the ledger: walking rows in commit
    // order, the running total (which is exactly what each request saw as
    // "used" when it was decided) can never exceed the allowance snapshot
    // carried by the row that was accepted. A request judged under `tight`
    // when the counter was already at 40+ MUST have been rejected; mixing
    // the two rule sets mid-request would violate this immediately.
    const { rows } = await pool.query(
      `select id, accepted, units_consumed,
              account_rules->>'monthly_allowance' as allowance
       from requests where account_id = $1 order by id asc`,
      [accountId],
    );
    expect(rows.length).toBe(30);
    const allowances = new Set(rows.map((r: { allowance: string }) => Number(r.allowance)));
    expect(allowances).toEqual(new Set([40, 60])); // both rule sets really were in play

    let running = 0;
    for (const row of rows as Array<{
      accepted: boolean;
      units_consumed: string;
      allowance: string;
    }>) {
      expect([40, 60]).toContain(Number(row.allowance));
      if (row.accepted) {
        running += Number(row.units_consumed);
        expect(running).toBeLessThanOrEqual(Number(row.allowance));
      }
    }
    expect(running).toBe(used);
    expect(used).toBeLessThanOrEqual(60); // never above the larger allowance
  });
});
