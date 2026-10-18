import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  api,
  bootstrapAccount,
  createTestPool,
  prepareDatabase,
  resetDatabase,
  type Agent,
} from './helpers.js';

// Every authenticated endpoint rejects missing or invalid API keys.

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

describe('api key validation', () => {
  it('rejects every protected route without an Authorization header', async () => {
    // Requests are built fresh at await time: supertest Test objects hold a
    // handle to their ephemeral server, so pre-building them in an array and
    // awaiting later races the server lifecycle.
    const probes: Array<() => ReturnType<Agent['get']>> = [
      () => agent.get('/v1/account'),
      () => agent.get('/v1/users'),
      () => agent.get('/v1/plans'),
      () => agent.get('/v1/usage'),
      () => agent.get('/v1/history'),
    ];
    for (const probe of probes) {
      const res = await probe();
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }
    const consume = await agent
      .post('/v1/consume')
      .send({ user_id: '11111111-1111-4111-8111-111111111111', request_id: 'r', units: 1 });
    expect(consume.status).toBe(401);
    expect(consume.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects non-Bearer schemes and malformed keys', async () => {
    const attempts = [
      { header: ['Authorization', 'Token um_whatever'] },
      { header: ['Authorization', 'Bearer not-a-um-key'] },
      { header: ['Authorization', 'Bearer um_'] },
      { header: ['X-Authorization', 'Bearer um_real-looking-but-fake'] },
    ];
    for (const { header } of attempts) {
      const res = await agent.get('/v1/account').set(...header);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejects a well-shaped but unknown key', async () => {
    const res = await agent
      .get('/v1/account')
      .set('Authorization', 'Bearer um_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(res.status).toBe(401);
  });

  it('accepts a real key issued at bootstrap', async () => {
    const { key } = await bootstrapAccount(agent, 'AuthCo');
    const res = await agent.get('/v1/account').set('Authorization', `Bearer ${key}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('AuthCo');
  });

  it('authenticates before routing: an invalid key on an unknown nested path is 401, not 404', async () => {
    const res = await agent.get('/v1/users/11111111-1111-4111-8111-111111111111/nope');
    expect(res.status).toBe(401);
  });
});
