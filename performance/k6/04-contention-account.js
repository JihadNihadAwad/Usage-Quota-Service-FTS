// Stage 04 - account-level contention: 100 VUs, each pinned to its OWN
// user (no user-row collisions), all funneling through ONE account row.
// Every consume must take the account counter lock, so throughput
// converges to roughly 1/transaction-duration no matter how many VUs
// pile on - the ceiling of a shared-counter design (analysis in
// ../README.md).
//
// The thresholds gate correctness under load (no failures, all accepted)
// plus a throughput floor (measured ceiling recorded in results/); the
// latency distribution is informative, not a pass/fail signal.
//
// Run: npm run bench:contention-account

import { check } from 'k6';
import { consume, consumeChecks, requestId, state, summary } from './lib.js';

export const options = {
  vus: 100,
  duration: '45s',
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
  const key = state.account.key;
  // VU n owns user n - user rows never collide; only the account row does.
  const user = state.users[(__VU - 1) % state.users.length];
  check(consume(key, user, requestId('a', data), 1), consumeChecks());
}
