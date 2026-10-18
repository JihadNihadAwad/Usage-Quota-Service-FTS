// Headless demo runner: the same scenarios as the web page, via the same
// client/core code, printed as a transcript. Exits non-zero if any
// expectation fails - doubles as the end-to-end check of every scenario.

import { UsageApi } from './core/api.js';
import { SCENARIO_COUNT, runScenario } from './core/scenarios.js';
import { freshState } from './core/state.js';

const USAGE_API_URL = process.env.USAGE_API_URL ?? 'http://localhost:3000/v1';

const api = new UsageApi(USAGE_API_URL);
const state = freshState();

console.log(`[demo] usage api: ${USAGE_API_URL}`);
let failed = false;

for (let n = 1; n <= SCENARIO_COUNT; n++) {
  const result = await runScenario({ api, state }, n);
  const badge = result.passed ? 'PASS' : 'FAIL';
  console.log(`\n${badge}  ${result.number}. ${result.title}`);
  for (const step of result.steps) {
    if (step.label !== undefined) console.log(`    - ${step.label}`);
    if (step.note !== undefined) console.log(`      ${step.note}`);
  }
  if (!result.passed) {
    failed = true;
    console.log(`      FAILURE: ${result.failure}`);
    break;
  }
}

console.log(failed ? '\n[demo] FAILED' : '\n[demo] all scenarios passed');
process.exit(failed ? 1 : 0);
