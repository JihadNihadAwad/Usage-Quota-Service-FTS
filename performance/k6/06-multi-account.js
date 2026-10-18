// Stage 06 - multi-account: 100 VUs pinned to TWO accounts (50 each, each VU
// to its own user). If the per-account serialization were a system-wide
// bottleneck, throughput would stay at the single-account ceiling (~163/s
// on this rig) and the >250/s floor would fail. If accounts are truly
// independent - different account_usage rows, different locks - throughput
// should approach 2x the single-account number.
//
// Run: npm run bench:multi-account

import { check } from 'k6';
import { consume, consumeChecks, requestId, state, summary, TREND_STATS } from './lib.js';

export const options = {
  vus: 100,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate==1'],
    // Floor: both accounts together must clearly beat ONE account's ceiling.
    http_reqs: ['rate>250'],
  },
  summaryTrendStats: TREND_STATS,
};

export const handleSummary = summary('06-multi-account');

export function setup() {
  return { runToken: `multi-${Date.now().toString(36)}` };
}

export default function (data) {
  // Even VUs drive account 1, odd VUs drive account 2.
  const first = __VU % 2 === 1;
  const key = first ? state.account.key : state.account2.key;
  const users = first ? state.users : state.users2;
  const user = users[(__VU - 1) % users.length];
  check(consume(key, user, requestId('m', data), 1), consumeChecks());
}
