// Shared helpers for every k6 stage in this directory. k6 bundles local
// imports into the test archive, so stages stay one screen each.
//
// The dataset (the seeded "Loadtest Co" accounts, each with an admin key and
// 100 users) is created by `npm run bench:seed` (performance/seed.ts) and
// lives in performance/loadtest-state.json - gitignored, since it holds
// live keys.

import http from 'k6/http';
// Pinned jslib module (versioned URL is standard k6 practice) for the
// human-readable end-of-test summary.
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.3/index.js';

export const BASE_URL = (__ENV.BASE_URL ?? 'http://localhost:3000') + '/v1';

// open() only works in the init context, so the dataset is read once here
// at bundle time and shared with every scenario through this import.
export const state = JSON.parse(open(__ENV.STATE_FILE ?? '/perf/loadtest-state.json'));

// Percentiles reported in every stage's console summary and exported JSON
// (p99 included — tail latency is part of the evidence).
export const TREND_STATS = ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'];

export function headers(key) {
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
  };
}

/**
 * One consume call. A quota REJECTION is an HTTP 200 with accepted:false in
 * the body, so http_req_failed only counts transport/protocol
 * failures - the `checks` carry the semantic assertions.
 */
export function consume(key, userId, requestId, units) {
  return http.post(
    `${BASE_URL}/consume`,
    JSON.stringify({ user_id: userId, request_id: requestId, units: units }),
    headers(key),
  );
}

/** Globally unique request id: run token + VU + iteration. */
export function requestId(prefix, data) {
  return `${data.runToken}-${prefix}-v${__VU}-i${__ITER}`;
}

/** The standard checks every successful consume must satisfy. */
export function consumeChecks(r) {
  return {
    'status 200': (r) => r.status === 200,
    accepted: (r) => r.json('accepted') === true,
    'charged in full': (r) => r.json('units_consumed') > 0,
  };
}

/** Write the full k6 summary to the results dir AND print it to stdout. */
export function summary(name) {
  return function handleSummary(data) {
    return {
      [`/perf/results/${name}.json`]: JSON.stringify(data, null, 2),
      stdout: textSummary(data, { indent: ' ', enableColors: false }),
    };
  };
}
