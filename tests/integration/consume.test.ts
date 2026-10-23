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
import { BASIC_PLAN_ID, PREMIUM_PLAN_ID, STARTER_PLAN_ID } from '../../src/db/predefined.js';

// The consume suite: happy path; every rejection class; replay and
// replay-conflict; concurrent requests that must not exceed limits;
// account total == sum of accepted units.

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

async function getJson(path: string, key: string): Promise<Record<string, any>> {
  const res = await agent.get(path).set('Authorization', `Bearer ${key}`);
  expect(res.status).toBe(200);
  return res.body as Record<string, any>;
}

describe('consume — happy path', () => {
  it('accepts a request that fits both plans, consuming the full amount at both levels', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow'); // Starter: 10,000/mo, 100/req
    const alice = await createUser(agent, key, 'alice'); // Basic: 1,000/mo, 20/req

    const res = await consume(key, alice.id, 'doc-1', 10);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      request_id: 'doc-1',
      accepted: true,
      units: 10,
      units_consumed: 10,
      reason: null,
      all_reasons: null,
    });
    expect(res.body.account).toMatchObject({
      plan_id: STARTER_PLAN_ID,
      used_units: 10,
      remaining: 9_990,
    });
    expect(res.body.user).toMatchObject({
      plan_id: BASIC_PLAN_ID,
      used_units: 10,
      remaining: 990,
    });
    expect(res.body.evaluated.account_rules).toEqual({
      monthly_allowance: 10_000,
      max_per_request: 100,
    });
    expect(res.body.evaluated.user_rules).toEqual({
      monthly_allowance: 1_000,
      max_per_request: 20,
    });

    // The usage endpoints see the same totals the decision reported.
    expect(await getJson('/v1/usage', key)).toMatchObject({ used_units: 10, remaining: 9_990 });
    expect(await getJson(`/v1/users/${alice.id}/usage`, key)).toMatchObject({
      used_units: 10,
      remaining: 990,
    });

    const history = await getJson('/v1/history', key);
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      request_id: 'doc-1',
      accepted: true,
      units_consumed: 10,
    });
  });
});

describe('consume — the four rejection classes', () => {
  it('rejects by the user per-request limit even though both allowances suffice', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const alice = await createUser(agent, key, 'alice'); // max 20/request

    const res = await consume(key, alice.id, 'doc-1', 25);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      accepted: false,
      units: 25,
      units_consumed: 0,
      reason: { level: 'user', rule: 'max_per_request' },
    });

    // A rejection consumes nothing.
    expect(await getJson('/v1/usage', key)).toMatchObject({ used_units: 0 });
    expect(await getJson(`/v1/users/${alice.id}/usage`, key)).toMatchObject({ used_units: 0 });
  });

  it('rejects by the account per-request limit', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const tightPlan = await createCustomPlan(agent, key, 'Tight', 'account', {
      monthly_allowance: 1_000,
      max_per_request: 5,
    });
    const patch = await agent
      .patch('/v1/account')
      .set('Authorization', `Bearer ${key}`)
      .send({ account_plan_id: tightPlan });
    expect(patch.status).toBe(200);

    const bob = await createUser(agent, key, 'bob', PREMIUM_PLAN_ID); // 100/request
    const res = await consume(key, bob.id, 'doc-1', 10);
    expect(res.body).toMatchObject({
      accepted: false,
      units_consumed: 0,
      reason: { level: 'account', rule: 'max_per_request' },
    });
  });

  it('rejects by the user monthly allowance, never partially consuming', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const smallPlan = await createCustomPlan(agent, key, 'Small', 'user', {
      monthly_allowance: 30,
      max_per_request: 100,
    });
    const alice = await createUser(agent, key, 'alice', smallPlan);

    const first = await consume(key, alice.id, 'doc-1', 20);
    expect(first.body).toMatchObject({ accepted: true, units_consumed: 20 });

    // 10 remain: a 20-unit request is rejected outright (full amount only).
    const second = await consume(key, alice.id, 'doc-2', 20);
    expect(second.body).toMatchObject({
      accepted: false,
      units_consumed: 0,
      reason: { level: 'user', rule: 'monthly_allowance' },
    });
    expect(second.body.all_reasons).toHaveLength(1);

    // A 15-unit request is also rejected (10 remaining < 15) - no partial.
    const third = await consume(key, alice.id, 'doc-3', 15);
    expect(third.body).toMatchObject({ accepted: false, reason: { rule: 'monthly_allowance' } });
    expect(await getJson(`/v1/users/${alice.id}/usage`, key)).toMatchObject({
      used_units: 20,
      remaining: 10,
    });
  });

  it('rejects by the shared account monthly allowance even though each user has plenty', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const sharedTight = await createCustomPlan(agent, key, 'SharedTight', 'account', {
      monthly_allowance: 50,
      max_per_request: 100,
    });
    const patch = await agent
      .patch('/v1/account')
      .set('Authorization', `Bearer ${key}`)
      .send({ account_plan_id: sharedTight });
    expect(patch.status).toBe(200);

    const u1 = await createUser(agent, key, 'u1', PREMIUM_PLAN_ID);
    const u2 = await createUser(agent, key, 'u2', PREMIUM_PLAN_ID);

    const first = await consume(key, u1.id, 'doc-1', 30);
    expect(first.body).toMatchObject({ accepted: true });

    const second = await consume(key, u2.id, 'doc-2', 30);
    expect(second.body).toMatchObject({
      accepted: false,
      units_consumed: 0,
      reason: { level: 'account', rule: 'monthly_allowance' },
    });

    // The account is down to 20; each user keeps their own totals.
    expect(await getJson('/v1/usage', key)).toMatchObject({ used_units: 30, remaining: 20 });
    expect(await getJson(`/v1/users/${u2.id}/usage`, key)).toMatchObject({ used_units: 0 });
  });
});

describe('consume — idempotency (safe retries)', () => {
  it('replays an accepted decision verbatim without consuming again', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const alice = await createUser(agent, key, 'alice');

    const first = await consume(key, alice.id, 'doc-1', 10);
    expect(first.body.accepted).toBe(true);

    const replay = await consume(key, alice.id, 'doc-1', 10);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body); // content-identical

    expect(await getJson('/v1/usage', key)).toMatchObject({ used_units: 10 });
    const history = await getJson('/v1/history', key);
    expect(history.items).toHaveLength(1); // still exactly one ledger row
  });

  it('replays a rejected decision verbatim, still consuming nothing', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const alice = await createUser(agent, key, 'alice'); // max 20/request

    const first = await consume(key, alice.id, 'doc-1', 25);
    expect(first.body.accepted).toBe(false);

    const replay = await consume(key, alice.id, 'doc-1', 25);
    expect(replay.body).toEqual(first.body);
    expect(await getJson('/v1/usage', key)).toMatchObject({ used_units: 0 });
  });

  it('rejects a reused request_id with a different payload (409)', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const alice = await createUser(agent, key, 'alice');
    const bob = await createUser(agent, key, 'bob');

    await consume(key, alice.id, 'doc-1', 10);

    const changedUnits = await consume(key, alice.id, 'doc-1', 15);
    expect(changedUnits.status).toBe(409);
    expect(changedUnits.body.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const changedUser = await consume(key, bob.id, 'doc-1', 10);
    expect(changedUser.status).toBe(409);
    expect(changedUser.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    // Neither attempt changed anything.
    expect(await getJson('/v1/usage', key)).toMatchObject({ used_units: 10 });
  });
});

describe('consume — isolation', () => {
  it('treats another account’s user (and a random uuid) as nonexistent', async () => {
    const mine = await bootstrapAccount(agent, 'DocuFlow');
    const rival = await bootstrapAccount(agent, 'Rival');
    const alice = await createUser(agent, mine.key, 'alice');

    const foreign = await consume(rival.key, alice.id, 'doc-1', 10);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'user not found' });

    const random = await consume(mine.key, '00000000-0000-4000-8000-000000000000', 'doc-1', 10);
    expect(random.status).toBe(404);
    expect(random.body.error.message).toBe('user not found'); // byte-identical masking
  });
});

describe('consume — concurrency (limits hold under parallel load)', () => {
  it('a single user’s parallel requests never exceed the user allowance', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow'); // Starter
    const userPlan = await createCustomPlan(agent, key, 'Hundred', 'user', {
      monthly_allowance: 100,
      max_per_request: 10,
    });
    const alice = await createUser(agent, key, 'alice', userPlan);

    // 20 concurrent requests of 10 units against a 100-unit allowance:
    // exactly 10 can be accepted, regardless of arrival order.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => consume(key, alice.id, `storm-${i}`, 10)),
    );

    for (const res of results) expect(res.status).toBe(200);
    const accepted = results.filter((r) => r.body.accepted === true);
    const rejected = results.filter((r) => r.body.accepted === false);
    expect(accepted).toHaveLength(10);
    expect(rejected).toHaveLength(10);
    for (const res of rejected) {
      expect(res.body.reason).toMatchObject({ level: 'user', rule: 'monthly_allowance' });
    }

    // Exact totals at both levels, and exactly 20 ledger rows.
    expect(await getJson(`/v1/users/${alice.id}/usage`, key)).toMatchObject({
      used_units: 100,
      remaining: 0,
    });
    expect(await getJson('/v1/usage', key)).toMatchObject({ used_units: 100 });
    const history = await getJson('/v1/history?limit=100', key);
    expect(history.items).toHaveLength(20);
    expect(history.items.reduce((sum: number, item: any) => sum + item.units_consumed, 0)).toBe(
      100,
    );
  });

  it('parallel users never exceed the shared account allowance (Σ users == account)', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const sharedTight = await createCustomPlan(agent, key, 'Fifty', 'account', {
      monthly_allowance: 50,
      max_per_request: 100,
    });
    const patch = await agent
      .patch('/v1/account')
      .set('Authorization', `Bearer ${key}`)
      .send({ account_plan_id: sharedTight });
    expect(patch.status).toBe(200);

    const users = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createUser(agent, key, `user-${i}`, PREMIUM_PLAN_ID)),
    );

    // 10 users x 5 concurrent requests of 10 units = 500 demanded; 50 fits.
    const results = await Promise.all(
      users.flatMap((u, ui) =>
        Array.from({ length: 5 }, (_, i) => consume(key, u.id, `acc-${ui}-${i}`, 10)),
      ),
    );

    const accepted = results.filter((r) => r.body.accepted === true);
    expect(accepted).toHaveLength(5);
    for (const res of results.filter((r) => r.body.accepted === false)) {
      expect(res.body.reason).toMatchObject({ level: 'account', rule: 'monthly_allowance' });
    }

    // The invariant: account total == Σ user totals == Σ accepted ledger units.
    const accountUsage = await getJson('/v1/usage', key);
    expect(accountUsage.used_units).toBe(50);
    const userUsages = await Promise.all(users.map((u) => getJson(`/v1/users/${u.id}/usage`, key)));
    expect(userUsages.reduce((sum: number, u: any) => sum + u.used_units, 0)).toBe(50);
    const history = await getJson('/v1/history?limit=100', key);
    expect(history.items).toHaveLength(50);
    expect(history.items.reduce((sum: number, item: any) => sum + item.units_consumed, 0)).toBe(50);
  });

  it('accepts exactly up to the boundary under concurrency (allowance 25, five requests of 5)', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const boundaryPlan = await createCustomPlan(agent, key, 'Boundary', 'user', {
      monthly_allowance: 25,
      max_per_request: 10,
    });
    const alice = await createUser(agent, key, 'alice', boundaryPlan);

    const firstWave = await Promise.all(
      Array.from({ length: 5 }, (_, i) => consume(key, alice.id, `b-${i}`, 5)),
    );
    for (const res of firstWave) expect(res.body.accepted).toBe(true);

    const sixth = await consume(key, alice.id, 'b-5', 5);
    expect(sixth.body).toMatchObject({
      accepted: false,
      reason: { level: 'user', rule: 'monthly_allowance' },
    });
    expect(await getJson(`/v1/users/${alice.id}/usage`, key)).toMatchObject({
      used_units: 25,
      remaining: 0,
    });
  });
});

describe('consume — the extra rule (monthly_request_cap) end to end', () => {
  it('counts accepted requests per month via the partial index and caps them', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const cappedPlan = await createCustomPlan(agent, key, 'ThreeCalls', 'user', {
      monthly_request_cap: 3,
    });
    const alice = await createUser(agent, key, 'alice', cappedPlan);

    const outcomes: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await consume(key, alice.id, `cap-${i}`, 1);
      outcomes.push(res.body.accepted as boolean);
    }
    expect(outcomes).toEqual([true, true, true, false]);

    const fourth = await consume(key, alice.id, 'cap-3', 1);
    expect(fourth.body.reason).toMatchObject({ level: 'user', rule: 'monthly_request_cap' });
    // No allowance configured on the user plan: remaining is null, not a number.
    expect(fourth.body.user.remaining).toBeNull();
    expect(fourth.body.account.remaining).toBe(9_997); // 3 accepted units on Starter
  });
});
