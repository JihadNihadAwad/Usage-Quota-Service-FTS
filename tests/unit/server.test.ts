import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../../src/http/server.js';

// Boot suite - no database required. Readiness is exercised with a dead pool
// (nothing listens on that port) and a stubbed pool, so the unit suite stays
// green on any machine, with or without Postgres running.
const deadPool = () =>
  new Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:59999/fts' });
const stubPool = () => ({ query: async () => ({ rows: [{ result: 1 }] }) }) as unknown as Pool;

describe('boot suite', () => {
  let pool: Pool | undefined;

  afterEach(async () => {
    if (pool) {
      await pool.end();
      pool = undefined;
    }
  });

  it('GET /healthz says the process is alive', async () => {
    const res = await request(createApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /readyz says 503 not-ready when the database is unreachable', async () => {
    pool = deadPool();
    const res = await request(createApp({ pool })).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not-ready' });
  });

  it('GET /readyz says 200 ready when the database answers', async () => {
    const res = await request(createApp({ pool: stubPool() })).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('unknown routes outside /v1 get the JSON error envelope', async () => {
    const res = await request(createApp()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'resource not found' },
    });
  });

  it('unknown /v1 routes without a key are 401, not 404 - auth gates first', async () => {
    const res = await request(createApp()).get('/v1/nope');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
