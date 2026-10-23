// Stage 08 - capacity sweep: a fixed number of concurrent clients for a
// fixed duration, everything set from the environment. Run it at several
// VU counts to trace the capacity curve: throughput rises with clients
// up to the first shared limit, then flattens while latency keeps
// growing. No throughput floor - the stage must be able to report a low
// number.
//
//   VUS=1000 RESULT_NAME=08-capacity-vus1000 npm run bench:capacity
//
// Run: VUS=100 npm run bench:capacity

import { check } from 'k6';
import { consume, consumeChecks, requestId, state, summary, TREND_STATS } from './lib.js';

export const options = {
  vus: Number(__ENV.VUS ?? 100),
  duration: __ENV.DURATION ?? '30s',
  summaryTrendStats: TREND_STATS,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate==1'],
  },
};

export const handleSummary = summary(__ENV.RESULT_NAME ?? '08-capacity');

export function setup() {
  return { runToken: `cap-${Date.now().toString(36)}` };
}

export default function (data) {
  // Round-robin across all seeded accounts so per-account locks never bind
  // before the shared limits do.
  const tenant = state.accounts[(__VU - 1) % state.accounts.length];
  const user = tenant.users[(__VU - 1) % tenant.users.length];
  check(consume(tenant.key, user, requestId('c', data), 1), consumeChecks());
}
