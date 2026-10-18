// Stage 02 - baseline: 2 VUs for 30s against all 100 users, 70% consume /
// 30% reads. This is the steady-state stage: no artificial contention, just
// the service doing its job. The service-level targets: p95 < 50 ms, no
// failures, every decision accepted.
//
// Run: npm run bench:baseline

import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, consume, consumeChecks, headers, requestId, state, summary } from './lib.js';

export const options = {
  vus: 2,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<50'],
    checks: ['rate==1'],
  },
};

export const handleSummary = summary('02-baseline');

export function setup() {
  return { runToken: `base-${Date.now().toString(36)}` };
}

export default function (data) {
  const key = state.account.key;
  const roll = __ITER % 10;

  if (roll < 7) {
    // 70%: consume, cycling through all users.
    const user = state.users[__ITER % state.users.length];
    check(consume(key, user, requestId('c', data), 1), consumeChecks());
  } else if (roll < 9) {
    // 20%: account usage read.
    const res = http.get(`${BASE_URL}/usage`, headers(key));
    check(res, { 'usage readable': (r) => r.status === 200 && 'used_units' in r.json() });
  } else {
    // 10%: history page.
    const res = http.get(`${BASE_URL}/history?limit=20`, headers(key));
    check(res, { 'history readable': (r) => r.status === 200 && Array.isArray(r.json('items')) });
  }
}
