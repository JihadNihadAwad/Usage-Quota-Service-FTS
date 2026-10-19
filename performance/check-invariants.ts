// Post-stage invariant check - run after EVERY k6 stage:
//
//   npm run bench:invariants
//
// Talks straight to the compose db (localhost:5432) and asserts, for EVERY
// loadtest account and the current UTC month:
//   1. account counter == sum of user counters == sum of accepted ledger units
//   2. every rejected ledger row consumed nothing
//   3. no counter ever exceeded its plan allowance
// A mismatch means the stage corrupted accounting and fails the run,
// regardless of latency results.

import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';

const STATE_FILE = fileURLToPath(new URL('./loadtest-state.json', import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/fts';

interface AccountRef {
  id: string;
  name: string;
}

interface State {
  accounts?: AccountRef[];
  // State files written before the scaling stage kept two accounts at the
  // top level instead of an array.
  account?: AccountRef;
  account2?: AccountRef;
}

const month = `${new Date().toISOString().slice(0, 7)}-01`;

const pool = new Pool({ connectionString: DATABASE_URL });

async function one(query: string, params: unknown[]): Promise<Record<string, unknown>> {
  const result = await pool.query(query, params);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no rows from: ${query}`);
  return row as Record<string, unknown>;
}

/** All invariant checks for one account. Prints a line per finding. */
async function checkAccount(name: string, accountId: string): Promise<boolean> {
  const params = [accountId, month];

  const accountRow = await pool.query(
    `select used_units from account_usage where account_id = $1 and month_start = $2`,
    params,
  );
  const accountUsed = Number(accountRow.rows[0]?.used_units ?? 0);

  const userRow = await one(
    `select coalesce(sum(uu.used_units), 0) as total
     from user_usage uu
     join users u on u.id = uu.user_id
     where u.account_id = $1 and uu.month_start = $2`,
    params,
  );
  const userSum = Number(userRow.total);

  const ledgerRow = await one(
    `select coalesce(sum(units_consumed), 0) as units, count(*) as accepted_count
     from requests
     where account_id = $1 and month_start = $2 and accepted`,
    params,
  );
  const ledgerSum = Number(ledgerRow.units);
  const acceptedCount = Number(ledgerRow.accepted_count);

  const rejectedRow = await one(
    `select count(*) as bad
     from requests
     where account_id = $1 and month_start = $2 and not accepted and units_consumed <> 0`,
    params,
  );
  const badRejections = Number(rejectedRow.bad);

  const allowanceRow = await one(
    `select (p.rules->>'monthly_allowance')::bigint as allowance
     from accounts a join plans p on p.id = a.account_plan_id
     where a.id = $1`,
    [accountId],
  );
  const accountAllowance = Number(allowanceRow.allowance);

  const overRow = await one(
    `select count(*) as over
     from user_usage uu
     join users u on u.id = uu.user_id
     join plans p on p.id = u.plan_id
     where u.account_id = $1 and uu.month_start = $2
       and p.rules->>'monthly_allowance' is not null
       and uu.used_units > (p.rules->>'monthly_allowance')::bigint`,
    params,
  );
  const overAllowance = Number(overRow.over);

  console.log(`[invariants] account ${name} (${accountId}), month ${month}`);
  console.log(
    `[invariants] account counter: ${accountUsed} / sum of user counters: ${userSum} / accepted ledger units: ${ledgerSum} (${acceptedCount} accepted requests)`,
  );

  const failures: string[] = [];
  if (accountUsed !== userSum) failures.push(`account counter != sum of user counters`);
  if (accountUsed !== ledgerSum) failures.push(`account counter != accepted ledger units`);
  if (userSum !== ledgerSum) failures.push(`sum of user counters != accepted ledger units`);
  if (badRejections !== 0) failures.push(`${badRejections} rejected rows consumed units`);
  if (accountUsed > accountAllowance) failures.push(`account counter exceeds its allowance`);
  if (overAllowance !== 0) failures.push(`${overAllowance} user counters exceed their allowance`);

  if (failures.length > 0) {
    for (const f of failures) console.error(`[invariants] FAIL: ${f}`);
    return false;
  }
  console.log(`[invariants] PASS - counters, ledger, and allowances agree`);
  return true;
}

async function main(): Promise<void> {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
  const accounts: AccountRef[] = Array.isArray(state.accounts)
    ? state.accounts
    : [state.account, state.account2].filter((a): a is AccountRef => a !== undefined);
  if (accounts.length === 0) {
    console.error('[invariants] no loadtest accounts in the state file - run npm run bench:seed');
    process.exitCode = 1;
    return;
  }
  let allPassed = true;
  for (const account of accounts) {
    allPassed = (await checkAccount(account.name, account.id)) && allPassed;
  }
  process.exitCode = allPassed ? 0 : 1;
}

main()
  .catch((err: unknown) => {
    console.error('[invariants] error:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
