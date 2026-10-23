// Stage 01 - smoke: one VU, one pass, correctness before speed.
//
// Checks the stack under load-test conditions: two accepts, a rule
// rejection (max_per_request), and an idempotent replay that is not
// charged twice. History is checked newest-first, so reruns of this
// stage accumulate rows without breaking the assertions.
//
// Run: npm run bench:smoke

import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, consume, headers, state, summary, TREND_STATS } from './lib.js';

export const options = {
  vus: 1,
  iterations: 1,
  summaryTrendStats: TREND_STATS,
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

export const handleSummary = summary('01-smoke');

export default function () {
  const tenant = state.accounts[0];
  const key = tenant.key;
  const run = `smoke-${Date.now().toString(36)}`;

  const first = consume(key, tenant.users[0], `${run}-1`, 1);
  check(first, {
    'first consume accepted': (r) => r.status === 200 && r.json('accepted') === true,
    'full amount consumed': (r) => r.json('units_consumed') === 1,
  });

  const second = consume(key, tenant.users[1], `${run}-2`, 2);
  check(second, {
    'second user accepted': (r) => r.status === 200 && r.json('accepted') === true,
  });

  // 5000 units exceeds the loadtest user plan's max_per_request (1000).
  const rejected = consume(key, tenant.users[0], `${run}-3`, 5000);
  check(rejected, {
    'oversized request rejected': (r) => r.status === 200 && r.json('accepted') === false,
    'rejection consumes nothing': (r) => r.json('units_consumed') === 0,
    'reason names rule and level': (r) => {
      const reason = r.json('reason');
      return reason !== null && reason.level === 'user' && reason.rule === 'max_per_request';
    },
  });

  const replay = consume(key, tenant.users[0], `${run}-1`, 1);
  check(replay, {
    'replay returns the same decision': (r) => r.status === 200 && r.json('accepted') === true,
    'replay reports the original charge': (r) => r.json('units_consumed') === 1,
  });

  const usage = http.get(`${BASE_URL}/usage`, headers(key));
  check(usage, {
    'usage readable': (r) => r.status === 200 && typeof r.json('used_units') === 'number',
  });

  // The three new rows are the newest three; the replay added none.
  const history = http.get(`${BASE_URL}/history?limit=3`, headers(key));
  check(history, {
    'history newest-first with the replay adding no row': (r) => {
      const items = r.json('items');
      return (
        r.status === 200 &&
        items.length === 3 &&
        items[0].request_id === `${run}-3` &&
        items[0].accepted === false &&
        items[1].request_id === `${run}-2` &&
        items[2].request_id === `${run}-1`
      );
    },
  });
}
