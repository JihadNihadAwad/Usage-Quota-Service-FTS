// Stage 07 - account scaling: 100 VUs spread across ALL seeded accounts
// (eight at the time of writing). Stage 06 showed two accounts locking
// different rows run independently; this stage spreads the load wide
// enough to find what limits total throughput. Measured on this stack:
// not the connection pool - pool 10 and pool 50 land within noise
// (results/07-account-scaling*) - but host CPU.
//
// The stage file is identical for both runs; the pool size is set on the api
// container between them, and RESULT_NAME keeps the outputs apart:
//   POOL_MAX=10  npm run bench:scaling   -> 07-account-scaling.*
//   POOL_MAX=50  ... -e RESULT_NAME=07-account-scaling-pool50
//                     -> 07-account-scaling-pool50.*
//
// Run: npm run bench:scaling

import { check } from 'k6';
import { consume, consumeChecks, requestId, state, summary, TREND_STATS } from './lib.js';

export const options = {
  vus: Number(__ENV.VUS ?? 100),
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate==1'],
    // Floor: eight accounts must at least match the two-account stage's rate.
    http_reqs: ['rate>250'],
  },
  summaryTrendStats: TREND_STATS,
};

export const handleSummary = summary(__ENV.RESULT_NAME ?? '07-account-scaling');

export function setup() {
  return { runToken: `scale-${Date.now().toString(36)}` };
}

export default function (data) {
  // Each VU is pinned round-robin to one account, one of that account's
  // users - so all locks stay per-tenant and the only shared resources left
  // are the api process and its connection pool.
  const tenant = state.accounts[(__VU - 1) % state.accounts.length];
  const user = tenant.users[(__VU - 1) % tenant.users.length];
  check(consume(tenant.key, user, requestId('s', data), 1), consumeChecks());
}
