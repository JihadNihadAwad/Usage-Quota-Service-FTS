// Stage 06 - multi-account: 100 VUs pinned to TWO accounts (50 each, each
// VU to its own user). If the per-account lock were a system-wide
// bottleneck, throughput would stay near the single-account rate (~163/s
// here) and the >250/s floor would fail. Two accounts locking different
// account_usage rows should approach twice the single-account number.
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
    // Floor: both accounts together must clearly beat the single-account rate.
    http_reqs: ['rate>250'],
  },
  summaryTrendStats: TREND_STATS,
};

export const handleSummary = summary('06-multi-account');

export function setup() {
  return { runToken: `multi-${Date.now().toString(36)}` };
}

export default function (data) {
  // Even VUs drive the first account, odd VUs the second.
  const first = __VU % 2 === 1;
  const tenant = first ? state.accounts[0] : state.accounts[1];
  const user = tenant.users[(__VU - 1) % tenant.users.length];
  check(consume(tenant.key, user, requestId('m', data), 1), consumeChecks());
}
