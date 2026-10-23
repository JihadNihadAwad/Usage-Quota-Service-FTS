// Stage 04 - account contention: 100 VUs, each pinned to its own user (no
// user-row collisions), all through one account. Every consume takes the
// account counter lock, so throughput converges to roughly
// 1/transaction-duration no matter how many clients are sent (analysis
// in ../README.md).
//
// The thresholds gate correctness under load (no failures, all accepted)
// plus a throughput floor (measured rate recorded in results/); the
// latency distribution is informative, not a pass/fail signal.
//
// Run: npm run bench:contention-account

import { check } from 'k6';
import { consume, consumeChecks, requestId, state, summary, TREND_STATS } from './lib.js';

export const options = {
  vus: 100,
  duration: '45s',
  summaryTrendStats: TREND_STATS,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate==1'],
    // Floor, not a target: the serialized account path must sustain at
    // least 50 decisions/second on the compose stack.
    http_reqs: ['rate>50'],
  },
};

export const handleSummary = summary('04-contention-account');

export function setup() {
  return { runToken: `acct-${Date.now().toString(36)}` };
}

export default function (data) {
  const tenant = state.accounts[0];
  // VU n owns user n - user rows never collide; only the account row does.
  const user = tenant.users[(__VU - 1) % tenant.users.length];
  check(consume(tenant.key, user, requestId('a', data), 1), consumeChecks());
}
