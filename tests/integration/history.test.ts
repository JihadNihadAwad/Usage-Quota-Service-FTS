import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  api,
  bootstrapAccount,
  createUser,
  createTestPool,
  prepareDatabase,
  resetDatabase,
  type Agent,
} from './helpers.js';

// History: previous months and request outcomes are queryable, with
// pagination over the ledger.

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

describe('history filters', () => {
  it('returns an empty page when nothing has been consumed', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const page = await getJson('/v1/history', key);
    expect(page).toEqual({ items: [], next_cursor: null });
  });

  it('filters by outcome (accepted / rejected) and by user_id', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const alice = await createUser(agent, key, 'alice'); // Basic: 20/request
    const bob = await createUser(agent, key, 'bob');

    for (const [id, units] of [
      ['h-1', 10],
      ['h-2', 25], // rejected (user max_per_request)
      ['h-3', 10],
    ] as const) {
      await agent
        .post('/v1/consume')
        .set('Authorization', `Bearer ${key}`)
        .send({ user_id: alice.id, request_id: id, units })
        .expect(200);
    }
    await agent
      .post('/v1/consume')
      .set('Authorization', `Bearer ${key}`)
      .send({ user_id: bob.id, request_id: 'h-4', units: 5 })
      .expect(200);

    const accepted = await getJson('/v1/history?outcome=accepted', key);
    expect(accepted.items).toHaveLength(3);
    const rejected = await getJson('/v1/history?outcome=rejected', key);
    expect(rejected.items).toHaveLength(1);
    expect(rejected.items[0].rejection).toMatchObject({ level: 'user', rule: 'max_per_request' });

    const aliceOnly = await getJson(`/v1/history?user_id=${alice.id}`, key);
    expect(aliceOnly.items).toHaveLength(3);
    const bobOnly = await getJson(`/v1/users/${bob.id}/history`, key);
    expect(bobOnly.items).toHaveLength(1);
    expect(bobOnly.items[0].request_id).toBe('h-4');
  });

  it('filters by month', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const alice = await createUser(agent, key, 'alice');
    await agent
      .post('/v1/consume')
      .set('Authorization', `Bearer ${key}`)
      .send({ user_id: alice.id, request_id: 'm-1', units: 5 })
      .expect(200);

    const current = new Date().toISOString().slice(0, 7);
    const thisMonth = await getJson(`/v1/history?month=${current}`, key);
    expect(thisMonth.items).toHaveLength(1);
    const emptyMonth = await getJson('/v1/history?month=2026-01', key);
    expect(emptyMonth.items).toHaveLength(0);
  });
});

describe('history pagination (keyset)', () => {
  it('walks every page to exhaustion without duplicates or losses, newest-first', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const alice = await createUser(agent, key, 'alice');
    for (let i = 0; i < 7; i++) {
      await agent
        .post('/v1/consume')
        .set('Authorization', `Bearer ${key}`)
        .send({ user_id: alice.id, request_id: `p-${i}`, units: 1 })
        .expect(200);
    }

    const collected: Array<{ id: number; request_id: string }> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await getJson(
        cursor === null ? '/v1/history?limit=3' : `/v1/history?limit=3&cursor=${cursor}`,
        key,
      );
      expect(page.items.length).toBeLessThanOrEqual(3);
      collected.push(...page.items);
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor !== null);

    expect(pages).toBe(3); // 3 + 3 + 1
    expect(collected).toHaveLength(7);
    expect(new Set(collected.map((item) => item.id)).size).toBe(7);
    for (let i = 1; i < collected.length; i++) {
      const prev = collected[i - 1];
      const curr = collected[i];
      if (prev !== undefined && curr !== undefined) {
        expect(prev.created_at >= curr.created_at).toBe(true);
      }
    }
  });

  it('is stable under concurrent inserts: a page fetched after new rows appears identically', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const alice = await createUser(agent, key, 'alice');
    for (let i = 0; i < 4; i++) {
      await agent
        .post('/v1/consume')
        .set('Authorization', `Bearer ${key}`)
        .send({ user_id: alice.id, request_id: `s-${i}`, units: 1 })
        .expect(200);
    }

    const page1 = await getJson('/v1/history?limit=2', key);
    const cursor = page1.next_cursor as string;
    const page2Before = await getJson(`/v1/history?limit=2&cursor=${cursor}`, key);

    // A newer row lands between page fetches - keyset cursors are unaffected.
    await agent
      .post('/v1/consume')
      .set('Authorization', `Bearer ${key}`)
      .send({ user_id: alice.id, request_id: 's-newest', units: 1 })
      .expect(200);

    const page2After = await getJson(`/v1/history?limit=2&cursor=${cursor}`, key);
    expect(page2After.items).toEqual(page2Before.items);
    // The new row shows up at the top of page 1.
    const freshPage1 = await getJson('/v1/history?limit=2', key);
    expect(freshPage1.items[0].request_id).toBe('s-newest');
  });

  it('rejects a garbage cursor with 400 INVALID_CURSOR', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const res = await agent.get('/v1/history?cursor=garbage').set('Authorization', `Bearer ${key}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });

  it('does not skip rows that share a millisecond with the cursor row', async () => {
    // Postgres timestamps carry microseconds; the cursor must too. Three
    // ledger rows inside the same millisecond, at distinct microsecond
    // offsets, with a page break after the middle row: the row with the
    // smallest offset must still be reachable through the cursor.
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const alice = await createUser(agent, key, 'alice');
    const month = new Date().toISOString().slice(0, 7);

    const rules = JSON.stringify({ monthly_allowance: 1000, max_per_request: 20 });
    const accountId = (await getJson('/v1/account', key)).id as string;
    const base = `date_trunc('second', now() - interval '1 hour')`;
    for (const [requestId, micros] of [
      ['us-1', 123],
      ['us-2', 456],
      ['us-3', 789],
    ] as const) {
      await pool.query(
        `insert into requests
           (account_id, user_id, request_id, units, month_start, accepted, units_consumed,
            account_plan_id, user_plan_id, account_rules, user_rules, response, created_at)
         values ($1, $2, $3, 1, $4::date, true, 1,
                '11111111-1111-4111-8111-111111111111',
                '33333333-3333-4333-8333-333333333333',
                $5::jsonb, $5::jsonb,
                jsonb_build_object('request_id', $3::text, 'accepted', true),
                ${base} + ($6 || ' microseconds')::interval)`,
        [accountId, alice.id, requestId, `${month}-01`, rules, micros],
      );
    }

    const page1 = await getJson('/v1/history?limit=2', key);
    expect(page1.items.map((item: { request_id: string }) => item.request_id)).toEqual([
      'us-3',
      'us-2',
    ]);
    const page2 = await getJson(`/v1/history?limit=2&cursor=${page1.next_cursor}`, key);
    expect(page2.items.map((item: { request_id: string }) => item.request_id)).toEqual(['us-1']);
    expect(page2.next_cursor).toBeNull();
  });

  it('clamps limit to 1..100 via validation (0 -> 400)', async () => {
    const { key } = await bootstrapAccount(agent, 'DocuFlow');
    const res = await agent.get('/v1/history?limit=0').set('Authorization', `Bearer ${key}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });
});
