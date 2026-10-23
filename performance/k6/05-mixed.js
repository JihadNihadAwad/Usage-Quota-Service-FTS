// Stage 05 - mixed workload: ramp 10 -> 50 VUs over ~100s with reads mixed
// in (70% consume / 15% usage / 10% history / 5% plan catalog), while one
// plan PATCH lands mid-ramp. Rules are re-read under the counter lock on
// every consume, so the change applies to in-flight traffic with no
// restart, and request rows store the new rules from the next request
// onward.
//
// Run: npm run bench:mixed

import http from 'k6/http';
import { check } from 'k6';
import {
  BASE_URL,
  consume,
  consumeChecks,
  headers,
  requestId,
  state,
  summary,
  TREND_STATS,
} from './lib.js';

export const options = {
  scenarios: {
    traffic: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 10 },
        { duration: '60s', target: 50 },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '10s',
      exec: 'traffic',
    },
    // A single plan edit, once, in the middle of the ramp: max_per_request
    // 1000 -> 1200. Real change, zero rejection risk (requests are 1 unit).
    planUpdate: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      startTime: '50s',
      exec: 'planUpdate',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate==1'],
  },
  summaryTrendStats: TREND_STATS,
};

export const handleSummary = summary('05-mixed');

export function setup() {
  return { runToken: `mix-${Date.now().toString(36)}` };
}

export function traffic(data) {
  const tenant = state.accounts[0];
  const key = tenant.key;
  const roll = __ITER % 20;

  if (roll < 14) {
    // 70%: consume, spread across users.
    const user = tenant.users[(__VU * 7 + __ITER) % tenant.users.length];
    check(consume(key, user, requestId('t', data), 1), consumeChecks());
  } else if (roll < 17) {
    // 15%: account usage.
    const res = http.get(`${BASE_URL}/usage`, headers(key));
    check(res, { 'usage readable': (r) => r.status === 200 && 'used_units' in r.json() });
  } else if (roll < 19) {
    // 10%: history page.
    const res = http.get(`${BASE_URL}/history?limit=20`, headers(key));
    check(res, { 'history readable': (r) => r.status === 200 && Array.isArray(r.json('items')) });
  } else {
    // 5%: plan catalog.
    const res = http.get(`${BASE_URL}/plans?scope=user`, headers(key));
    check(res, { 'plans readable': (r) => r.status === 200 && Array.isArray(r.json('items')) });
  }
}

export function planUpdate(data) {
  const tenant = state.accounts[0];
  const key = tenant.key;
  // The state file carries user ids, not plan ids - look the plan up
  // through the API, as a client would.
  const user = http.get(`${BASE_URL}/users/${tenant.users[0]}`, headers(key));
  const planId = user.json('plan.id');
  const res = http.patch(
    `${BASE_URL}/plans/${planId}`,
    JSON.stringify({
      rules: {
        monthly_allowance: 1000000,
        max_per_request: 1200,
        monthly_request_cap: 1000000,
      },
    }),
    headers(key),
  );
  check(res, {
    'plan patch applied mid-run': (r) =>
      r.status === 200 && r.json('rules').max_per_request === 1200,
  });
  console.log(
    `plan updated mid-run (request ids ${data.runToken}-t-*) - new rule snapshots from the next consume`,
  );
}
