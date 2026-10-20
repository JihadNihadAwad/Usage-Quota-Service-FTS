// Stage 03 - single-user contention: 25 VUs, every request for the SAME
// user through the SAME account. Both counter rows are hot: each request
// queues on the account lock and then the user lock, so latency here IS
// the serialization the design accepts - the queue depth shows up
// directly in the p95/p99.
//
// Informative stage: no latency threshold. What must hold: no transport
// failures and every decision accepted.
//
// Run: npm run bench:contention-user

import { check } from 'k6';
import { consume, consumeChecks, requestId, state, summary, TREND_STATS } from './lib.js';

export const options = {
  vus: 25,
  duration: '30s',
  summaryTrendStats: TREND_STATS,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate==1'],
  },
};

export const handleSummary = summary('03-contention-single-user');

export function setup() {
  return { runToken: `user-${Date.now().toString(36)}` };
}

export default function (data) {
  const tenant = state.accounts[0];
  check(consume(tenant.key, tenant.users[0], requestId('u', data), 1), consumeChecks());
}
