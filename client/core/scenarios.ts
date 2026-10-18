// The seven demo scenarios - ONE implementation shared by the web UI and the
// headless runner, with the expected outcomes asserted inline so the demo
// doubles as an end-to-end check. If an expectation breaks, the card shows
// FAIL and the headless runner exits non-zero.
//
// The story (in order, against a fresh account):
//   1. Setup        - bootstrap DocuFlow, alice (Basic) + bob (Premium)
//   2. Small doc    - alice consumes 10 -> accepted at both levels
//   3. Big doc      - alice requests 25 -> rejected by user max_per_request
//   4. Tight plan   - custom 50/mo account plan; 30 accepted, next 30
//                     rejected by the shared account monthly_allowance
//   5. Upgrade      - switch the account to Pro; the SAME client call that
//                     just failed is now accepted - no client code changed
//   6. Replay       - same request_id twice -> identical decision, charged once
//   7. Run all      - every scenario, fresh account, in order

import { deepStrictEqual } from 'node:assert';
import { PREMIUM_PLAN_ID, PRO_PLAN_ID } from '../../src/db/predefined.js';
import type { ConsumeDecisionDto, UsageDto } from './api.js';
import { freshState, type DemoState } from './state.js';

export interface DemoContext {
  api: import('./api.js').UsageApi;
  state: DemoState;
}

export interface StepResult {
  label?: string;
  response?: unknown;
  note?: string;
}

export interface ScenarioResult {
  number: number;
  title: string;
  passed: boolean;
  failure?: string;
  steps: StepResult[];
}

class ExpectError extends Error {}

function expect(condition: boolean, label: string): void {
  if (!condition) throw new ExpectError(label);
}

function expectEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new ExpectError(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function nextRequestId(state: DemoState, tag: string): string {
  state.callSeq += 1;
  return `${state.runId}-${tag}-${state.callSeq}`;
}

interface SetupIds {
  key: string;
  accountId: string;
  alice: string;
  bob: string;
}

function requireSetup(state: DemoState): SetupIds {
  if (
    state.apiKey === null ||
    state.accountId === null ||
    state.aliceUserId === null ||
    state.bobUserId === null
  ) {
    throw new ExpectError(
      'no account in this run yet - run Scenario 1 (Setup) or 7 (Run all) first',
    );
  }
  return {
    key: state.apiKey,
    accountId: state.accountId,
    alice: state.aliceUserId,
    bob: state.bobUserId,
  };
}

/** A compact one-line summary of a decision, for cards and the transcript. */
export function summarizeDecision(d: ConsumeDecisionDto): string {
  const levels = (lvl: 'account' | 'user') => {
    const s = d[lvl];
    return `${lvl} ${s.used_units} used, ${s.remaining ?? 'unlimited'} left`;
  };
  if (d.accepted) {
    return `ACCEPTED ${d.units} units (consumed ${d.units_consumed}) - ${levels('user')}; ${levels('account')}`;
  }
  const reason = d.reason;
  return `REJECTED by ${reason?.level}.${reason?.rule} - ${reason?.message ?? ''} (consumed ${d.units_consumed})`;
}

function decisionStep(label: string, d: ConsumeDecisionDto): StepResult {
  return { label: `${label} -> ${summarizeDecision(d)}`, response: d };
}

async function usageStep(
  ctx: DemoContext,
  label: string,
  fetch: () => Promise<UsageDto>,
): Promise<StepResult> {
  const usage = await fetch();
  return {
    label: `${label} -> ${usage.used_units} used, ${usage.remaining ?? 'unlimited'} remaining (${usage.plan.name})`,
    response: usage,
  };
}

interface ScenarioDef {
  number: number;
  title: string;
  needsSetup: boolean;
  run(ctx: DemoContext): Promise<StepResult[]>;
}

const SCENARIO_DEFS: ScenarioDef[] = [
  {
    number: 1,
    title: 'Setup - bootstrap the account and its users',
    needsSetup: false,
    async run({ api, state }) {
      Object.assign(state, freshState()); // every Setup starts a fresh run + account
      const created = await api.createAccount('DocuFlow');
      state.apiKey = created.api_key.key;
      state.accountId = created.account.id;

      const alice = await api.createUser(created.api_key.key, 'alice');
      const bob = await api.createUser(created.api_key.key, 'bob', PREMIUM_PLAN_ID);
      state.aliceUserId = alice.id;
      state.bobUserId = bob.id;

      expectEq(alice.plan.name, 'Basic', 'alice defaults to the Basic user plan');
      expectEq(bob.plan.name, 'Premium', 'bob is on the Premium user plan');
      expectEq(created.account.plan.name, 'Starter', 'account starts on Starter');

      return [
        {
          label: `POST /v1/accounts - DocuFlow bootstrapped, API key issued (kept server-side, shown once)`,
          response: {
            account: {
              id: created.account.id,
              name: created.account.name,
              plan: created.account.plan.name,
            },
            api_key: {
              key_prefix: created.api_key.key_prefix,
              note: 'full key never leaves the demo server',
            },
          },
        },
        { label: `POST /v1/users - alice on ${alice.plan.name}`, response: alice },
        { label: `POST /v1/users - bob on ${bob.plan.name}`, response: bob },
        await usageStep({ api, state }, 'GET /v1/usage - fresh month, nothing consumed yet', () =>
          api.getAccountUsage(created.api_key.key),
        ),
      ];
    },
  },
  {
    number: 2,
    title: 'Small document - accepted at both levels',
    needsSetup: true,
    async run({ api, state }) {
      const { key, alice } = requireSetup(state);
      const before = await api.getUserUsage(key, alice);
      const decision = await api.consume(key, alice, nextRequestId(state, 'small'), 10);
      const after = await api.getUserUsage(key, alice);

      expect(
        decision.accepted,
        '10 units should be accepted (Basic allows 20/request, 1000/month)',
      );
      expectEq(decision.units_consumed, 10, 'the FULL amount is consumed');
      expectEq(after.used_units - before.used_units, 10, 'alice usage moved by exactly 10');

      return [
        decisionStep('POST /v1/consume - alice, 10 units', decision),
        {
          note: "The same 10 units count against alice individually AND against DocuFlow's shared allowance.",
        },
      ];
    },
  },
  {
    number: 3,
    title: 'Oversized document - rejected by the user per-request limit',
    needsSetup: true,
    async run({ api, state }) {
      const { key, alice } = requireSetup(state);
      const before = await api.getAccountUsage(key);
      const decision = await api.consume(key, alice, nextRequestId(state, 'oversized'), 25);
      const after = await api.getAccountUsage(key);

      expect(!decision.accepted, '25 units exceed the Basic per-request limit of 20');
      expectEq(decision.units_consumed, 0, 'a rejection consumes nothing');
      expectEq(decision.reason?.level, 'user', 'the failing rule belongs to the user level');
      expectEq(decision.reason?.rule, 'max_per_request', 'the failing rule is max_per_request');
      expectEq(after.used_units - before.used_units, 0, 'account usage unchanged');

      return [
        decisionStep('POST /v1/consume - alice, 25 units', decision),
        { note: 'The account had plenty of allowance left - the USER plan is what said no.' },
      ];
    },
  },
  {
    number: 4,
    title: 'Tight custom account plan - the shared limit says stop',
    needsSetup: true,
    async run({ api, state }) {
      const { key, bob } = requireSetup(state);

      // Custom plan (demonstrates create + assign). Reused within a run so
      // re-clicking this scenario doesn't 409 on the plan name.
      let planNote = 'created custom account plan "DocuFlow Trial" (50/month, 100/request)';
      let planId = state.customPlanId;
      if (planId === null) {
        const plan = await api.createPlan(key, 'DocuFlow Trial', 'account', {
          monthly_allowance: 50,
          max_per_request: 100,
        });
        planId = plan.id;
        state.customPlanId = plan.id;
      } else {
        planNote = 'reusing this run\'s custom "DocuFlow Trial" plan';
      }

      const patch = await api.patchAccountPlan(key, planId);
      expectEq(patch.plan.name, 'DocuFlow Trial', 'account switched to the custom plan');

      const before = await api.getAccountUsage(key);
      const first = await api.consume(key, bob, nextRequestId(state, 'trial-ok'), 30);
      const mid = await api.getAccountUsage(key);
      const second = await api.consume(key, bob, nextRequestId(state, 'trial-reject'), 30);
      const after = await api.getAccountUsage(key);

      expect(first.accepted, 'first 30 units fit the 50/month trial plan');
      expectEq(mid.used_units - before.used_units, 30, 'account usage moved by 30');
      expect(!second.accepted, 'the second 30 units do NOT fit');
      expectEq(second.reason?.level, 'account', 'this time the ACCOUNT level rejects');
      expectEq(second.reason?.rule, 'monthly_allowance', 'via the shared monthly allowance');
      expectEq(after.used_units - mid.used_units, 0, 'the rejection consumed nothing');

      return [
        { label: `POST /v1/plans + PATCH /v1/account - ${planNote}`, response: patch },
        decisionStep('POST /v1/consume - bob, 30 units', first),
        decisionStep('POST /v1/consume - bob, another 30 units', second),
        {
          note: 'bob is on Premium (10,000/month, 100/request) - his user plan is fine; the ACCOUNT plan is the blocker.',
        },
      ];
    },
  },
  {
    number: 5,
    title: 'Plan switch to Pro - the same call now passes, client unchanged',
    needsSetup: true,
    async run({ api, state }) {
      const { key, bob } = requireSetup(state);
      const patch = await api.patchAccountPlan(key, PRO_PLAN_ID);
      expectEq(patch.plan.name, 'Pro', 'account switched to the predefined Pro plan');

      const before = await api.getAccountUsage(key);
      const decision = await api.consume(key, bob, nextRequestId(state, 'pro'), 30);
      const after = await api.getAccountUsage(key);

      expect(decision.accepted, 'under Pro (100,000/month) the 30-unit request fits');
      expectEq(decision.account.plan_id, PRO_PLAN_ID, 'judged by the Pro plan');
      expectEq(after.used_units - before.used_units, 30, 'account usage moved by 30');

      return [
        {
          label: 'PATCH /v1/account - switch to Pro (usage preserved, no fresh allowance)',
          response: patch,
        },
        decisionStep('POST /v1/consume - bob, 30 units, SAME client code as scenario 4', decision),
        {
          note: 'The client called consume identically; only the plan configuration changed. Changes apply without redeploying anything.',
        },
      ];
    },
  },
  {
    number: 6,
    title: 'Idempotent replay - same request_id, charged exactly once',
    needsSetup: true,
    async run({ api, state }) {
      const { key, alice } = requireSetup(state);
      const id = nextRequestId(state, 'replay');

      const accBefore = await api.getAccountUsage(key);
      const usrBefore = await api.getUserUsage(key, alice);
      const first = await api.consume(key, alice, id, 15);
      const replay = await api.consume(key, alice, id, 15);
      const accAfter = await api.getAccountUsage(key);
      const usrAfter = await api.getUserUsage(key, alice);

      expect(first.accepted && replay.accepted, 'both submissions are accepted decisions');
      try {
        // Content-identical, not byte-identical: jsonb normalizes key order
        // deep equality is the contract.
        deepStrictEqual(replay, first);
      } catch {
        throw new ExpectError('the replayed response differs from the original');
      }
      expectEq(accAfter.used_units - accBefore.used_units, 15, 'account usage moved exactly once');
      expectEq(usrAfter.used_units - usrBefore.used_units, 15, 'alice usage moved exactly once');

      return [
        decisionStep(`POST /v1/consume - alice, 15 units, request_id "${id}" (1st)`, first),
        decisionStep(`POST /v1/consume - alice, 15 units, request_id "${id}" (retry)`, replay),
        await usageStep({ api, state }, 'GET /v1/usage after the replay', () =>
          api.getAccountUsage(key),
        ),
        {
          note: 'A crashed-and-retried caller gets the same decision and is never double-charged.',
        },
      ];
    },
  },
  {
    number: 7,
    title: 'Run all - every scenario from a fresh account',
    needsSetup: false,
    async run(ctx) {
      const steps: StepResult[] = [{ note: 'Fresh account, then scenarios 1-6 in order.' }];
      for (let n = 1; n <= 6; n++) {
        const result = await runScenario(ctx, n);
        for (const step of result.steps) {
          steps.push({
            ...step,
            label: step.label === undefined ? undefined : `[${n}] ${step.label}`,
            note: step.note,
          });
        }
        if (!result.passed) {
          throw new ExpectError(`scenario ${n} (${result.title}) failed: ${result.failure}`);
        }
      }
      return steps;
    },
  },
];

export const SCENARIO_COUNT = SCENARIO_DEFS.length;

export function scenarioCatalog(): Array<{ number: number; title: string; needsSetup: boolean }> {
  return SCENARIO_DEFS.map(({ number, title, needsSetup }) => ({ number, title, needsSetup }));
}

export async function runScenario(ctx: DemoContext, n: number): Promise<ScenarioResult> {
  const def = SCENARIO_DEFS.find((s) => s.number === n);
  if (def === undefined) throw new Error(`unknown scenario ${n}`);
  const result: ScenarioResult = { number: def.number, title: def.title, passed: true, steps: [] };
  try {
    result.steps = await def.run(ctx);
  } catch (err) {
    result.passed = false;
    result.failure = err instanceof Error ? err.message : String(err);
  }
  return result;
}
