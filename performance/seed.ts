// Load-test dataset seed - idempotent, run before any k6 stage:
//
//   npm run bench:seed
//
// Creates (or reuses, via performance/loadtest-state.json) EIGHT independent
// accounts, "Loadtest Co" .. "Loadtest Co 8", each with:
//   - a custom account-scope plan with very generous limits (100M/month,
//     10k/request), so stages measure locking and throughput, not rejections
//   - a custom user-scope plan exercising ALL THREE rules (1M/month,
//     1k/request, 1M accepted calls/month), so every consume runs the
//     full rule path, not a shortcut
//   - 100 users load-001 .. load-100, all on that account's user plan
//
// Why eight: stage 06 showed two tenants locking two different
// account_usage rows run independently; the scaling stage (07) spreads
// the load wide enough to find what limits total throughput.
//
// The state file holds a live admin key per account -> gitignored. Reuse is
// keyed by the stored key still working (a GET /account probe), NOT by
// account name: names are labels, not unique ids. If the state file is lost
// while the db keeps its rows, the script simply creates a fresh set of
// accounts alongside the unreachable ones (there is no delete API); stages
// and the invariant checker all read ids from the state file, so they
// follow whichever dataset the file points at.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API_BASE = process.env.USAGE_API_URL ?? 'http://localhost:3000/v1';
const STATE_FILE = fileURLToPath(new URL('./loadtest-state.json', import.meta.url));

// The first two predate the scaling stage and their ledgers hold the stage
// 02-06 history, so they are always reused, never recreated.
const ACCOUNT_NAMES = [
  'Loadtest Co',
  'Loadtest Co 2',
  'Loadtest Co 3',
  'Loadtest Co 4',
  'Loadtest Co 5',
  'Loadtest Co 6',
  'Loadtest Co 7',
  'Loadtest Co 8',
];
const ACCOUNT_PLAN_NAME = 'Loadtest Account';
const USER_PLAN_NAME = 'Loadtest User';
const USER_COUNT = 100;

interface AccountRef {
  id: string;
  name: string;
  key: string;
}

interface AccountEntry extends AccountRef {
  users: string[];
}

interface State {
  accounts: AccountEntry[];
  createdAt: string;
}

/** State files written before the scaling stage; translated on load. */
interface LegacyState {
  account: AccountRef;
  users: string[];
  account2?: AccountRef;
  users2?: string[];
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

/** Read the state file, translating any pre-scaling format into the current
 *  shape. Returns null when the file is absent or unreadable. */
function loadStateFile(): State | null {
  if (!existsSync(STATE_FILE)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as unknown;
  } catch {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.accounts)) return parsed as State;
  // Two-account era: fold the top-level fields into the accounts array.
  const legacy = parsed as LegacyState;
  const accounts: AccountEntry[] = [];
  if (legacy.account !== undefined) accounts.push({ ...legacy.account, users: legacy.users });
  if (legacy.account2 !== undefined) {
    accounts.push({ ...legacy.account2, users: legacy.users2 ?? [] });
  }
  return { accounts, createdAt: new Date().toISOString() };
}

/**
 * The live dataset: every expected account name maps to exactly one entry
 * whose key still works. Dead or missing entries are created fresh (stale
 * rows remain in the db - there is no delete API - but the state file only
 * ever points at working keys).
 */
async function buildState(): Promise<State> {
  const existing = loadStateFile() ?? { accounts: [], createdAt: new Date().toISOString() };
  const accounts: AccountEntry[] = [];
  for (const entry of existing.accounts) {
    if (ACCOUNT_NAMES.includes(entry.name) && (await accountAlive(entry))) {
      accounts.push(entry);
    }
  }
  for (const name of ACCOUNT_NAMES) {
    if (accounts.some((entry) => entry.name === name)) continue;
    const created = await createDataset(name);
    accounts.push({ ...created.account, users: created.users });
  }
  return { accounts, createdAt: existing.createdAt };
}

/** One full tenant: account bootstrap + generous plans + 100 users. */
async function createDataset(
  name: string,
): Promise<{ account: AccountRef; accountPlanId: string; userPlanId: string; users: string[] }> {
  // 1. Bootstrap the account (the one unauthenticated mutation). Account
  // names are labels, not unique ids - a lost state file just means a fresh
  // dataset is bootstrapped next to any orphaned rows.
  const bootstrap = await call('POST', '/accounts', null, { name });
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

const state = await buildState();
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');

for (const entry of state.accounts) {
  console.log(
    `[bench:seed] account "${entry.name}" (${entry.id}) ready: ` +
      `${entry.users.length} users on "${USER_PLAN_NAME}", account plan "${ACCOUNT_PLAN_NAME}"`,
  );
}
console.log(`[bench:seed] ${state.accounts.length} accounts total`);
console.log(`[bench:seed] state: ${STATE_FILE}`);
