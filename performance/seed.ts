// Load-test dataset bootstrap - idempotent, run before any k6 stage:
//
//   npm run bench:seed
//
// Creates (or reuses, via performance/loadtest-state.json):
//   - TWO independent accounts, "Loadtest Co" and "Loadtest Co 2", each on
//     a custom account-scope plan with very generous limits (100M/month,
//     10k/request), so stages measure locking and throughput, not rejections
//   - a custom user-scope plan per account exercising ALL THREE rules
//     (1M/month, 1k/request, 1M accepted calls/month) - the request-cap rule
//     forces the partial-index count query onto every consume, so the
//     benchmark exercises the full rule path, not a shortcut
//   - 100 users load-001 .. load-100 per account, all on that account's plan
//
// The second account exists for the multi-account stage: two tenants locking
// two different account_usage rows prove the serialization ceiling is
// per-account, not global.
//
// The state file holds a live admin key per account -> gitignored. If it is
// lost while the db keeps the accounts, the script stops with instructions
// rather than guessing (there is deliberately no delete API).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API_BASE = process.env.USAGE_API_URL ?? 'http://localhost:3000/v1';
const STATE_FILE = fileURLToPath(new URL('./loadtest-state.json', import.meta.url));

const ACCOUNT_NAME = 'Loadtest Co';
const SECOND_ACCOUNT_NAME = 'Loadtest Co 2';
const ACCOUNT_PLAN_NAME = 'Loadtest Account';
const USER_PLAN_NAME = 'Loadtest User';
const USER_COUNT = 100;

interface AccountRef {
  id: string;
  name: string;
  key: string;
}

interface State {
  account: AccountRef;
  accountPlanId: string;
  userPlanId: string;
  users: string[];
  account2: AccountRef;
  users2: string[];
  createdAt: string;
}

interface Json {
  [key: string]: unknown;
}

async function call(
  method: string,
  path: string,
  key: string | null,
  body?: unknown,
): Promise<Json> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(key === null ? {} : { Authorization: `Bearer ${key}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) {
    const error = parsed.error as { code?: string; message?: string } | undefined;
    const err = new Error(
      `${method} ${path} -> ${res.status} ${error?.code ?? ''} ${error?.message ?? ''}`,
    ) as Error & { status: number; code: string };
    err.status = res.status;
    err.code = error?.code ?? 'UNKNOWN';
    throw err;
  }
  return parsed;
}

/** Is this state entry still a live account with a working key? */
async function accountAlive(account: AccountRef | undefined): Promise<boolean> {
  if (account === undefined) return false;
  try {
    const current = await call('GET', '/account', account.key);
    return (current.id as string) === account.id;
  } catch {
    return false;
  }
}

async function loadExisting(): Promise<State | null> {
  if (!existsSync(STATE_FILE)) return null;
  let state: State;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
  } catch {
    return null;
  }
  if (!(await accountAlive(state.account))) return null; // key stale or db wiped
  // Older state files predate the second account; build just that one.
  if (!(await accountAlive(state.account2))) {
    const second = await createDataset(SECOND_ACCOUNT_NAME);
    state.account2 = second.account;
    state.users2 = second.users;
  }
  return state;
}

/** One full tenant: account bootstrap + generous plans + 100 users. */
async function createDataset(
  name: string,
): Promise<{ account: AccountRef; accountPlanId: string; userPlanId: string; users: string[] }> {
  // 1. Bootstrap the account (the one unauthenticated mutation).
  let bootstrap;
  try {
    bootstrap = await call('POST', '/accounts', null, { name });
  } catch (err) {
    if (err instanceof Error && 'status' in err && err.status === 409) {
      throw new Error(
        `account "${ACCOUNT_NAME}" already exists but ${STATE_FILE} is gone or stale.\n` +
          '  The state file holds the only admin key; the API has no delete endpoint.\n' +
          '  Reset the dataset with:  docker compose down -v && docker compose up -d --wait && npm run bench:seed',
      );
    }
    throw err;
  }
  const accountId = (bootstrap.account as Json).id as string;
  const key = ((bootstrap.api_key as Json).key as string) ?? '';

  // 2. Generous account plan, then assign it.
  const accountPlan = await call('POST', '/plans', key, {
    name: ACCOUNT_PLAN_NAME,
    scope: 'account',
    rules: { monthly_allowance: 100_000_000, max_per_request: 10_000 },
  });
  await call('PATCH', '/account', key, { account_plan_id: accountPlan.id as string });

  // 3. The user plan all three rules run through.
  const userPlan = await call('POST', '/plans', key, {
    name: USER_PLAN_NAME,
    scope: 'user',
    rules: {
      monthly_allowance: 1_000_000,
      max_per_request: 1_000,
      monthly_request_cap: 1_000_000,
    },
  });

  // 4. Users load-001 .. load-100.
  const users: string[] = [];
  for (let i = 1; i <= USER_COUNT; i++) {
    const externalId = `load-${String(i).padStart(3, '0')}`;
    const user = await call('POST', '/users', key, {
      external_id: externalId,
      plan_id: userPlan.id as string,
    });
    users.push(user.id as string);
  }

  return {
    account: { id: accountId, name, key },
    accountPlanId: accountPlan.id as string,
    userPlanId: userPlan.id as string,
    users,
  };
}

async function createState(): Promise<State> {
  const first = await createDataset(ACCOUNT_NAME);
  const second = await createDataset(SECOND_ACCOUNT_NAME);
  return {
    account: first.account,
    accountPlanId: first.accountPlanId,
    userPlanId: first.userPlanId,
    users: first.users,
    account2: second.account,
    users2: second.users,
    createdAt: new Date().toISOString(),
  };
}

const state = (await loadExisting()) ?? (await createState());
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');

console.log(
  `[bench:seed] account "${state.account.name}" (${state.account.id}) ready: ` +
    `${state.users.length} users on "${USER_PLAN_NAME}", account plan "${ACCOUNT_PLAN_NAME}"`,
);
console.log(
  `[bench:seed] account "${state.account2.name}" (${state.account2.id}) ready: ` +
    `${state.users2.length} users`,
);
console.log(`[bench:seed] state: ${STATE_FILE}`);
