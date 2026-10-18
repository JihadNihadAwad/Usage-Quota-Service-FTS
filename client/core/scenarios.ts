// The demo program - ONE implementation shared by the web UI and the
// headless runner, with expected outcomes asserted inline so the demo
// doubles as an end-to-end check. If an expectation breaks, the card shows
// FAIL and the headless runner exits non-zero.
//
// Two sections, both rendered by the same machinery:
//
//   The story (scenarios 1-7):
//     1. Setup        - bootstrap DocuFlow, alice (Basic) + bob (Premium)
//     2. Small doc    - alice consumes 10 -> accepted at both levels
//     3. Big doc      - alice requests 25 -> rejected by user max_per_request
//     4. Tight plan   - custom 50/mo account plan; 30 accepted, next 30
//                       rejected by the shared account monthly_allowance
//     5. Upgrade      - switch the account to Pro; the SAME client call that
//                       just failed is now accepted - no client code changed
//     6. Replay       - same request_id twice -> identical decision, charged once
//     7. Run all      - every scenario, fresh account, in order
//
//   Checks (8-13) - extra buttons for additional behaviors
//   to verify, all non-mutating for the state built by scenarios 1-7:
//     8.  Isolation - a second account cannot see this one (404 masking)
//     9.  Retry conflict - same request_id, different payload (409)
//     10. Predefined plans are read-only (403)
//     11. Usage - current AND previous months
//     12. History - keyset pagination with a cursor
//     13. Plan scope rules - an account plan cannot be assigned to a user (400)

import { deepStrictEqual } from 'node:assert';
import { PREMIUM_PLAN_ID, PRO_PLAN_ID, STARTER_PLAN_ID } from '../../src/db/predefined.js';
import {
  ApiCallError,
  type ConsumeDecisionDto,
  type RequestInfo,
  type UsageDto,
  UsageApi,
} from './api.js';
import { freshState, type DemoState } from './state.js';

export type ScenarioCategory = 'story' | 'check';

export interface DemoContext {
  api: UsageApi;
  state: DemoState;
}

export interface StepResult {
  label?: string;
  /** The API call this step made - shown next to the response. */
  request?: RequestInfo;
  /** HTTP status, when the expected outcome IS an error (409/403/404/400). */
  status?: number;
  response?: unknown;
  note?: string;
}

export interface ScenarioResult {
  number: number;
  title: string;
  category: ScenarioCategory;
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

/** Run a call that is EXPECTED to fail with a specific status + code; return
 *  the error (with its request info) for display. */
async function expectApiError(
  run: () => Promise<unknown>,
  status: number,
  code: string,
): Promise<ApiCallError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiCallError && err.status === status && err.code === code) return err;
    if (err instanceof ExpectError) throw err;
    throw new ExpectError(
      `expected HTTP ${status} ${code}, got ${err instanceof ApiCallError ? `${err.status} ${err.code}` : String(err)}`,
    );
  }
  throw new ExpectError(`expected HTTP ${status} ${code}, but the call succeeded`);
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

function decisionStep(
  label: string,
  r: { request: RequestInfo; data: ConsumeDecisionDto },
): StepResult {
  return {
    label: `${label} -> ${summarizeDecision(r.data)}`,
    request: r.request,
    response: r.data,
  };
}

async function usageStep(
  ctx: DemoContext,
  label: string,
  fetch: () => Promise<{ request: RequestInfo; data: UsageDto }>,
): Promise<StepResult> {
  const r = await fetch();
  return {
    label: `${label} -> ${r.data.used_units} used, ${r.data.remaining ?? 'unlimited'} remaining (${r.data.plan.name}, month ${r.data.month})`,
    request: r.request,
    response: r.data,
  };
}

interface ScenarioDef {
  number: number;
  title: string;
  category: ScenarioCategory;
  needsSetup: boolean;
  run(ctx: DemoContext): Promise<StepResult[]>;
}

const SCENARIO_DEFS: ScenarioDef[] = [
  // ------------------------- scenarios (1-7) -------------------------
  {
    number: 1,
    title: 'Setup - bootstrap the account and its users',
    category: 'story',
    needsSetup: false,
    async run({ api, state }) {
      Object.assign(state, freshState()); // every Setup starts a fresh run + account
      const created = await api.createAccount('DocuFlow');
      state.apiKey = created.data.api_key.key;
      state.accountId = created.data.account.id;

      const alice = await api.createUser(created.data.api_key.key, 'alice');
      const bob = await api.createUser(created.data.api_key.key, 'bob', PREMIUM_PLAN_ID);
      state.aliceUserId = alice.data.id;
      state.bobUserId = bob.data.id;

      expectEq(alice.data.plan.name, 'Basic', 'alice defaults to the Basic user plan');
      expectEq(bob.data.plan.name, 'Premium', 'bob is on the Premium user plan');
      expectEq(created.data.account.plan.name, 'Starter', 'account starts on Starter');

      return [
        {
          label:
            'POST /v1/accounts - DocuFlow bootstrapped, API key issued (kept server-side, shown once)',
          request: created.request,
          response: {
            account: {
              id: created.data.account.id,
              name: created.data.account.name,
              plan: created.data.account.plan.name,
            },
            api_key: {
              key_prefix: created.data.api_key.key_prefix,
              note: 'full key never leaves the demo server',
            },
          },
        },
        {
          label: `POST /v1/users - alice on ${alice.data.plan.name}`,
          request: alice.request,
          response: alice.data,
        },
        {
          label: `POST /v1/users - bob on ${bob.data.plan.name}`,
          request: bob.request,
          response: bob.data,
        },
        await usageStep({ api, state }, 'GET /v1/usage - fresh month, nothing consumed yet', () =>
          api.getAccountUsage(created.data.api_key.key),
        ),
      ];
    },
  },
  {
    number: 2,
    title: 'Small document - accepted at both levels',
    category: 'story',
    needsSetup: true,
    async run({ api, state }) {
      const { key, alice } = requireSetup(state);
      const before = await api.getUserUsage(key, alice);
      const call = await api.consume(key, alice, nextRequestId(state, 'small'), 10);
      const after = await api.getUserUsage(key, alice);

      expect(
        call.data.accepted,
        '10 units should be accepted (Basic allows 20/request, 1000/month)',
      );
      expectEq(call.data.units_consumed, 10, 'the FULL amount is consumed');
      expectEq(
        after.data.used_units - before.data.used_units,
        10,
        'alice usage moved by exactly 10',
      );

      return [
        decisionStep('POST /v1/consume - alice, 10 units', call),
        {
          note: "The same 10 units count against alice individually AND against DocuFlow's shared allowance.",
        },
      ];
    },
  },
  {
    number: 3,
    title: 'Oversized document - rejected by the user per-request limit',
    category: 'story',
    needsSetup: true,
    async run({ api, state }) {
      const { key, alice } = requireSetup(state);
      const before = await api.getAccountUsage(key);
      const call = await api.consume(key, alice, nextRequestId(state, 'oversized'), 25);
      const after = await api.getAccountUsage(key);

      expect(!call.data.accepted, '25 units exceed the Basic per-request limit of 20');
      expectEq(call.data.units_consumed, 0, 'a rejection consumes nothing');
      expectEq(call.data.reason?.level, 'user', 'the failing rule belongs to the user level');
      expectEq(call.data.reason?.rule, 'max_per_request', 'the failing rule is max_per_request');
      expectEq(after.data.used_units - before.data.used_units, 0, 'account usage unchanged');

      return [
        decisionStep('POST /v1/consume - alice, 25 units', call),
        { note: 'The account had plenty of allowance left - the USER plan is what said no.' },
      ];
    },
  },
  {
    number: 4,
    title: 'Tight custom account plan - the shared limit says stop',
    category: 'story',
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
        planId = plan.data.id;
        state.customPlanId = plan.data.id;
      } else {
        planNote = 'reusing this run\'s custom "DocuFlow Trial" plan';
      }

      const patch = await api.patchAccountPlan(key, planId);
      expectEq(patch.data.plan.name, 'DocuFlow Trial', 'account switched to the custom plan');

      const before = await api.getAccountUsage(key);
      const first = await api.consume(key, bob, nextRequestId(state, 'trial-ok'), 30);
      const mid = await api.getAccountUsage(key);
      const second = await api.consume(key, bob, nextRequestId(state, 'trial-reject'), 30);
      const after = await api.getAccountUsage(key);

      expect(first.data.accepted, 'first 30 units fit the 50/month trial plan');
      expectEq(mid.data.used_units - before.data.used_units, 30, 'account usage moved by 30');
      expect(!second.data.accepted, 'the second 30 units do NOT fit');
      expectEq(second.data.reason?.level, 'account', 'this time the ACCOUNT level rejects');
      expectEq(second.data.reason?.rule, 'monthly_allowance', 'via the shared monthly allowance');
      expectEq(after.data.used_units - mid.data.used_units, 0, 'the rejection consumed nothing');

      return [
        {
          label: `POST /v1/plans + PATCH /v1/account - ${planNote}`,
          request: patch.request,
          response: patch.data,
        },
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
    category: 'story',
    needsSetup: true,
    async run({ api, state }) {
      const { key, bob } = requireSetup(state);
      const patch = await api.patchAccountPlan(key, PRO_PLAN_ID);
      expectEq(patch.data.plan.name, 'Pro', 'account switched to the predefined Pro plan');

      const before = await api.getAccountUsage(key);
      const call = await api.consume(key, bob, nextRequestId(state, 'pro'), 30);
      const after = await api.getAccountUsage(key);

      expect(call.data.accepted, 'under Pro (100,000/month) the 30-unit request fits');
      expectEq(call.data.account.plan_id, PRO_PLAN_ID, 'judged by the Pro plan');
      expectEq(after.data.used_units - before.data.used_units, 30, 'account usage moved by 30');

      return [
        {
          label: 'PATCH /v1/account - switch to Pro (usage preserved, no fresh allowance)',
          request: patch.request,
          response: patch.data,
        },
        decisionStep('POST /v1/consume - bob, 30 units, SAME client code as scenario 4', call),
        {
          note: 'The client called consume identically; only the plan configuration changed. Changes apply without redeploying anything.',
        },
      ];
    },
  },
  {
    number: 6,
    title: 'Idempotent replay - same request_id, charged exactly once',
    category: 'story',
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

      expect(
        first.data.accepted && replay.data.accepted,
        'both submissions are accepted decisions',
      );
      try {
        // Content-identical, not byte-identical: jsonb normalizes key order
        // deep equality is the contract.
        deepStrictEqual(replay.data, first.data);
      } catch {
        throw new ExpectError('the replayed response differs from the original');
      }
      expectEq(
        accAfter.data.used_units - accBefore.data.used_units,
        15,
        'account usage moved exactly once',
      );
      expectEq(
        usrAfter.data.used_units - usrBefore.data.used_units,
        15,
        'alice usage moved exactly once',
      );

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
    category: 'story',
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

  // ---------------------- checks (8-13) ----------------------
  {
    number: 8,
    title: 'Isolation - a second account cannot see this one',
    category: 'check',
    needsSetup: true,
    async run({ api, state }) {
      const { key, alice } = requireSetup(state);

      // A rival application bootstraps itself (unauthenticated by design)
      // and then pokes at DocuFlow's user with ITS key.
      const rival = await api.createAccount('Rival Co');
      const rivalKey = rival.data.api_key.key;

      const getView = await expectApiError(() => api.getUser(rivalKey, alice), 404, 'NOT_FOUND');
      const getUsage = await expectApiError(
        () => api.getUserUsage(rivalKey, alice),
        404,
        'NOT_FOUND',
      );
      const getHistory = await expectApiError(
        () => api.listUserHistory(rivalKey, alice),
        404,
        'NOT_FOUND',
      );
      const patchAttempt = await expectApiError(
        () => api.patchUserPlan(rivalKey, alice, PREMIUM_PLAN_ID),
        404,
        'NOT_FOUND',
      );

      // Sanity: DocuFlow's own key still sees alice.
      const own = await api.getUser(key, alice);
      expectEq(own.data.external_id, 'alice', 'the owning key still sees the user');

      return [
        {
          label: 'POST /v1/accounts - Rival Co bootstraps itself (gets its own key)',
          request: rival.request,
          response: { account: { name: rival.data.account.name }, note: 'isolated tenant' },
        },
        {
          label: 'Rival GET /v1/users/{alice} -> 404 NOT_FOUND',
          request: getView.request,
          status: getView.status,
          response: { error: { code: getView.code, message: getView.message } },
        },
        {
          label: 'Rival GET /v1/users/{alice}/usage -> 404 NOT_FOUND',
          request: getUsage.request,
          status: getUsage.status,
          response: { error: { code: getUsage.code, message: getUsage.message } },
        },
        {
          label: 'Rival GET /v1/users/{alice}/history -> 404 NOT_FOUND',
          request: getHistory.request,
          status: getHistory.status,
          response: { error: { code: getHistory.code, message: getHistory.message } },
        },
        {
          label: 'Rival PATCH /v1/users/{alice} -> 404 NOT_FOUND',
          request: patchAttempt.request,
          status: patchAttempt.status,
          response: { error: { code: patchAttempt.code, message: patchAttempt.message } },
        },
        {
          note: 'Foreign resources are indistinguishable from nonexistent ones - a 403 would leak that alice exists. Nothing was mutated.',
        },
      ];
    },
  },
  {
    number: 9,
    title: 'Retry conflict - same request_id, different payload',
    category: 'check',
    needsSetup: true,
    async run({ api, state }) {
      const { key, alice, bob } = requireSetup(state);
      const id = nextRequestId(state, 'conflict');

      const original = await api.consume(key, alice, id, 5);
      expect(original.data.accepted, 'the original 5-unit request is accepted');

      const moreUnits = await expectApiError(
        () => api.consume(key, alice, id, 6),
        409,
        'IDEMPOTENCY_CONFLICT',
      );
      const otherUser = await expectApiError(
        () => api.consume(key, bob, id, 5),
        409,
        'IDEMPOTENCY_CONFLICT',
      );
      // The same payload again is still a clean replay.
      const replay = await api.consume(key, alice, id, 5);
      expectEq(replay.data.accepted, true, 'same payload still replays fine');

      return [
        decisionStep(`POST /v1/consume - alice, 5 units, request_id "${id}"`, original),
        {
          label: `Same request_id, 6 units -> 409 IDEMPOTENCY_CONFLICT`,
          request: moreUnits.request,
          status: moreUnits.status,
          response: { error: { code: moreUnits.code, message: moreUnits.message } },
        },
        {
          label: `Same request_id, different user -> 409 IDEMPOTENCY_CONFLICT`,
          request: otherUser.request,
          status: otherUser.status,
          response: { error: { code: otherUser.code, message: otherUser.message } },
        },
        decisionStep('Same request_id, same payload again -> clean replay', replay),
        {
          note: 'A request_id pins the whole payload; a retry is only safe when it resends the same payload.',
        },
      ];
    },
  },
  {
    number: 10,
    title: 'Predefined plans are read-only',
    category: 'check',
    needsSetup: true,
    async run({ api, state }) {
      const { key } = requireSetup(state);

      const attempt = await expectApiError(
        () => api.patchPlan(key, STARTER_PLAN_ID, { rules: { monthly_allowance: 999_999 } }),
        403,
        'PLAN_IMMUTABLE',
      );
      // The catalog is unchanged.
      const plans = await api.listPlans(key, 'account');
      const starter = plans.data.items.find((p) => p.name === 'Starter');
      expectEq(starter?.rules.monthly_allowance, 10_000, 'Starter is untouched');

      return [
        {
          label: 'PATCH /v1/plans/{Starter} -> 403 PLAN_IMMUTABLE',
          request: attempt.request,
          status: attempt.status,
          response: { error: { code: attempt.code, message: attempt.message } },
        },
        {
          label: 'GET /v1/plans?scope=account - catalog unchanged',
          request: plans.request,
          response: { items: plans.data.items.map((p) => `${p.name} ${JSON.stringify(p.rules)}`) },
        },
        {
          note: 'Predefined plans are platform-owned; accounts copy the idea by creating their own custom plan.',
        },
      ];
    },
  },
  {
    number: 11,
    title: 'Usage - current and previous months',
    category: 'check',
    needsSetup: true,
    async run({ api, state }) {
      const { key, alice } = requireSetup(state);

      const current = await api.getAccountUsage(key);
      expectEq(
        current.data.month,
        `${new Date().toISOString().slice(0, 7)}-01`,
        'defaults to the current UTC month',
      );

      // An old month never had usage rows created (lazy materialization):
      // zero usage, full allowance, distinct counters per month.
      const previous = await api.getAccountUsage(key, '2026-01');
      expectEq(previous.data.used_units, 0, 'a month with no activity reports zero usage');

      const userCurrent = await api.getUserUsage(key, alice);
      const userPrevious = await api.getUserUsage(key, alice, '2026-01');
      expectEq(userPrevious.data.used_units, 0, 'same for the user level');

      return [
        await usageStep({ api, state }, 'GET /v1/usage (current month, no param)', () =>
          Promise.resolve(current),
        ),
        await usageStep({ api, state }, 'GET /v1/usage?month=2026-01 (previous month)', () =>
          Promise.resolve(previous),
        ),
        await usageStep({ api, state }, `GET /v1/users/{alice}/usage (current)`, () =>
          Promise.resolve(userCurrent),
        ),
        await usageStep({ api, state }, 'GET /v1/users/{alice}/usage?month=2026-01', () =>
          Promise.resolve(userPrevious),
        ),
        { note: 'Each UTC month is its own counter; previous months stay queryable forever.' },
      ];
    },
  },
  {
    number: 12,
    title: 'History - keyset pagination with a cursor',
    category: 'check',
    needsSetup: true,
    async run({ api, state }) {
      const { key, alice } = requireSetup(state);

      // Make sure there are at least three ledger rows so pagination has
      // something to page through (tiny 1-unit fillers; capped).
      for (let i = 0; i < 3; i++) {
        const probe = await api.listHistory(key, { limit: 2 });
        if (probe.data.items.length >= 2 && probe.data.next_cursor !== null) break;
        await api.consume(key, alice, nextRequestId(state, 'filler'), 1);
      }

      const page1 = await api.listHistory(key, { limit: 2 });
      expect(page1.data.items.length === 2, 'page 1 is full');
      expect(page1.data.next_cursor !== null, 'page 1 hands us a cursor');

      const page2 = await api.listHistory(key, {
        limit: 2,
        cursor: page1.data.next_cursor ?? undefined,
      });
      expect(page2.data.items.length >= 1, 'page 2 has rows');

      const ids1 = page1.data.items.map((i) => i.id);
      const ids2 = page2.data.items.map((i) => i.id);
      const overlap = ids1.filter((id) => ids2.includes(id));
      expect(overlap.length === 0, 'pages never overlap');
      const all = [...page1.data.items, ...page2.data.items];
      expect(
        all.every((item, idx) => {
          if (idx === 0) return true;
          const prev = all[idx - 1];
          return prev !== undefined && prev.created_at >= item.created_at;
        }),
        'rows are ordered newest-first across pages',
      );

      return [
        {
          label: 'GET /v1/history?limit=2 - page 1',
          request: page1.request,
          response: {
            items: page1.data.items.map(itemLine),
            next_cursor: truncate(page1.data.next_cursor),
          },
        },
        {
          label: 'GET /v1/history?limit=2&cursor=... - page 2 (follows the cursor)',
          request: page2.request,
          response: {
            items: page2.data.items.map(itemLine),
            next_cursor: truncate(page2.data.next_cursor),
          },
        },
        {
          note: "Keyset pagination: the cursor is the last row's sort key, so concurrent inserts can never make a row skip between pages (unlike OFFSET).",
        },
      ];
    },
  },
  {
    number: 13,
    title: 'Plan scope rules - an account plan cannot be assigned to a user',
    category: 'check',
    needsSetup: true,
    async run({ api, state }) {
      const { key, alice } = requireSetup(state);

      const attempt = await expectApiError(
        () => api.patchUserPlan(key, alice, STARTER_PLAN_ID),
        400,
        'PLAN_SCOPE_MISMATCH',
      );
      // alice's plan is untouched.
      const aliceAfter = await api.getUser(key, alice);
      expectEq(aliceAfter.data.plan.scope, 'user', 'alice still has a user-scoped plan');

      return [
        {
          label:
            'PATCH /v1/users/{alice} with the Starter (account) plan -> 400 PLAN_SCOPE_MISMATCH',
          request: attempt.request,
          status: attempt.status,
          response: { error: { code: attempt.code, message: attempt.message } },
        },
        {
          label: 'GET /v1/users/{alice} - assignment untouched',
          request: aliceAfter.request,
          response: { plan: aliceAfter.data.plan.name, scope: aliceAfter.data.plan.scope },
        },
        {
          note: 'Scopes are enforced at assignment: account plans limit the shared pool, user plans limit individuals.',
        },
      ];
    },
  },
];

function itemLine(item: {
  request_id: string;
  units: number;
  accepted: boolean;
  units_consumed: number;
}): string {
  return `#${item.request_id} ${item.units}u -> ${item.accepted ? `accepted (${item.units_consumed} consumed)` : 'rejected'}`;
}

function truncate(cursor: string | null): string | null {
  return cursor === null ? null : `${cursor.slice(0, 24)}…`;
}

export const SCENARIO_COUNT = SCENARIO_DEFS.length;

export function scenarioCatalog(): Array<{
  number: number;
  title: string;
  category: ScenarioCategory;
  needsSetup: boolean;
}> {
  return SCENARIO_DEFS.map(({ number, title, category, needsSetup }) => ({
    number,
    title,
    category,
    needsSetup,
  }));
}

export async function runScenario(ctx: DemoContext, n: number): Promise<ScenarioResult> {
  const def = SCENARIO_DEFS.find((s) => s.number === n);
  if (def === undefined) throw new Error(`unknown scenario ${n}`);
  const result: ScenarioResult = {
    number: def.number,
    title: def.title,
    category: def.category,
    passed: true,
    steps: [],
  };
  try {
    result.steps = await def.run(ctx);
  } catch (err) {
    result.passed = false;
    result.failure = err instanceof Error ? err.message : String(err);
  }
  return result;
}
