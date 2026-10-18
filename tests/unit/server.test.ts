import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/http/server.js';

// Gate: the toolchain (vitest + supertest + express 5 + ESM TS)
// works end-to-end on this machine from commit #1.
describe('hello-world boot ', () => {
  it('GET /healthz returns 200 ok', async () => {
    const res = await request(createApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /readyz reports 503 not-ready until the DB wires up', async () => {
    const res = await request(createApp()).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not-ready');
  });

  it('unknown routes return the JSON error envelope', async () => {
    const res = await request(createApp()).get('/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'resource not found' },
    });
  });
});
