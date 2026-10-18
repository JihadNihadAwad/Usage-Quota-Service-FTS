import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/http/server.js';

// HTTP smoke tests that need no database: the auth gate runs before any
// route touches the db, and request validation runs before handlers too.
// The db-backed suites run against the compose test db.

describe('auth gate', () => {
  it('rejects requests with no Authorization header', async () => {
    const res = await request(createApp()).get('/v1/account');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'missing Authorization: Bearer <key> header' },
    });
  });

  it('rejects a non-Bearer scheme', async () => {
    const res = await request(createApp())
      .get('/v1/account')
      .set('Authorization', 'Token um_something');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a Bearer key with the wrong shape without touching the db', async () => {
    const res = await request(createApp())
      .get('/v1/account')
      .set('Authorization', 'Bearer not-a-um-key');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('request validation', () => {
  it('rejects an invalid bootstrap body with per-field details', async () => {
    const res = await request(createApp()).post('/v1/accounts').send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(res.body.error.details).toEqual([{ path: 'name', message: expect.any(String) }]);
  });

  it('rejects unknown body keys - typos fail loudly', async () => {
    const res = await request(createApp())
      .post('/v1/accounts')
      .send({ name: 'Acme', acount_plan_id: '11111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('rejects malformed JSON with INVALID_JSON', async () => {
    const res = await request(createApp())
      .post('/v1/accounts')
      .set('Content-Type', 'application/json')
      .send('{"name": "Acme"');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});
