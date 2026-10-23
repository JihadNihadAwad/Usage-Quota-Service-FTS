// Stage 09 - saturation: drive a fixed ARRIVAL RATE regardless of how fast
// the service answers, stepping 500 -> 1000 -> 1500 requests/s over a
// minute. Past what the service can serve, the queue grows: latency climbs
// with each step until k6 runs out of VUs for in-flight requests
// (dropped_iterations in the summary) - arrivals beyond that are never
// sent. No requests fail, and the invariant check still passes afterwards.
//
// Run: npm run bench:saturation

import { check } from 'k6';
import { consume, consumeChecks, requestId, state, summary, TREND_STATS } from './lib.js';

export const options = {
  scenarios: {
    arrive: {
      executor: 'ramping-arrival-rate',
      startRate: 500,
      timeUnit: '1s',
      stages: [
        { duration: '20s', target: 500 },
        { duration: '20s', target: 1000 },
        { duration: '20s', target: 1500 },
      ],
      preAllocatedVUs: 1000,
      maxVUs: 4000,
    },
  },
  summaryTrendStats: TREND_STATS,
  thresholds: {
    // Transport failures must stay at zero even in overload: the queue is
    // the degradation, not errors.
    http_req_failed: ['rate<0.01'],
    checks: ['rate==1'],
  },
};

export const handleSummary = summary(__ENV.RESULT_NAME ?? '09-saturation');

export function setup() {
  return { runToken: `sat-${Date.now().toString(36)}` };
}

export default function (data) {
  const tenant = state.accounts[(__VU - 1) % state.accounts.length];
  const user = tenant.users[(__VU - 1) % tenant.users.length];
  check(consume(tenant.key, user, requestId('s', data), 1), consumeChecks());
}
