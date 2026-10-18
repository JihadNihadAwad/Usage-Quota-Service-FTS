// Headless demo runner: the same program as the web page, via the same
// client/core code, printed as a transcript. Exits non-zero if any
// expectation fails - doubles as the end-to-end check of every scenario
// AND the checks.

import { UsageApi } from './core/api.js';
import { scenarioCatalog, runScenario, type ScenarioCategory } from './core/scenarios.js';
import { freshState } from './core/state.js';

const USAGE_API_URL = process.env.USAGE_API_URL ?? 'http://localhost:3000/v1';

const api = new UsageApi(USAGE_API_URL);
const state = freshState();

console.log(`[demo] usage api: ${USAGE_API_URL}`);

const catalog = scenarioCatalog();
let failed = false;
let lastCategory: ScenarioCategory | null = null;

for (const { number } of catalog) {
  const result = await runScenario({ api, state }, number);
  if (result.category !== lastCategory) {
    console.log(result.category === 'check' ? '\n--- checks ---' : '\n--- scenarios ---');
    lastCategory = result.category;
  }
  const badge = result.passed ? 'PASS' : 'FAIL';
  console.log(`\n${badge}  ${result.number}. ${result.title}`);
  for (const step of result.steps) {
    if (step.label !== undefined) console.log(`    - ${step.label}`);
    if (step.request !== undefined) {
      const body = step.request.body === undefined ? '' : ` ${JSON.stringify(step.request.body)}`;
      console.log(`      ${step.request.method} /v1${step.request.path}${body}`);
    }
    if (step.note !== undefined) console.log(`      ${step.note}`);
  }
  if (!result.passed) {
    failed = true;
    console.log(`      FAILURE: ${result.failure}`);
    break;
  }
}

console.log(failed ? '\n[demo] FAILED' : '\n[demo] all scenarios and checks passed');
process.exit(failed ? 1 : 0);
