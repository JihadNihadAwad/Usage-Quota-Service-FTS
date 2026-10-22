import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { evaluateConsume, type Decision, type LevelContext } from '../domain/decision.js';
import type { Rules } from '../domain/rules/schemas.js';
import { monthStart } from '../domain/month.js';
import { ConflictError, NotFoundError } from '../http/errors.js';
import { logger } from '../lib/logger.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/pg-errors.js';

/**
 * The consume transaction.
 *
 * One READ COMMITTED transaction with explicit SQL for every critical
 * statement, so the locking protocol is inspectable statement by statement:
 *
 *   1. load user+plan and account+plan (ownership re-validated here, in tx)
 *   2. SELECT ... FOR UPDATE the account_usage row   <- lock #1 (serialization point)
 *   3. SELECT ... FOR UPDATE the user_usage row      <- lock #2 (fixed order: deadlock-free)
 *      (each counter row is created lazily on the month's FIRST consume,
 *      under the lock - steady state is one locked read, no setup)
 *   4. idempotency check under the locks (authoritative)
 *   5. pure evaluation over the locked snapshot (used_units and accepted
 *      request counts both live on the counter rows, so every rule reads O(1))
 *   6. if accepted: consume the full amount at both levels, incrementing the
 *      request counts in the same UPDATE (RETURNING the new totals)
 *   7. insert the ledger row: decision + rule snapshots + the exact response body
 *   8. COMMIT
 *
 * Why READ COMMITTED + explicit locks rather than SERIALIZABLE: our
 * contention pattern is a single hot row per account; pessimistic locking
 * gives deterministic behavior without SERIALIZABLE's retry storms.
 * Why not an application mutex: single-instance
 * only, and the locks must live with the data anyway.
 */

/** The transaction handle drizzle hands to the callback. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface ConsumeInput {
  userId: string;
  requestId: string;
  units: number;
}

interface LevelStateDto {
  plan_id: string;
  used_units: number;
  remaining: number | null;
}

/** The wire-format decision body. Built once, stored, and returned verbatim on replays. */
export interface ConsumeResponseBody {
  request_id: string;
  accepted: boolean;
  units: number;
  /** 0 for rejections - a rejection consumes nothing. Always present. */
  units_consumed: number;
  /** Primary reason; null on acceptance. Stable shape: fields are always present. */
  reason: { level: string; rule: string; message: string } | null;
  /** Every rule that denied the request, precedence-ordered; null on acceptance. */
  all_reasons: Array<{ level: string; rule: string; message: string }> | null;
  account: LevelStateDto;
  user: LevelStateDto;
  evaluated: { account_rules: Rules; user_rules: Rules };
}

export interface ConsumeResult {
  response: ConsumeResponseBody;
  replayed: boolean;
}

interface StoredRequest {
  userId: string;
  units: number;
  response: ConsumeResponseBody;
}

export async function consume(
  db: Db,
  accountId: string,
  input: ConsumeInput,
): Promise<ConsumeResult> {
  const start = performance.now();

  // Fast path: replays of already-committed decisions skip the transaction
  // entirely (stored body returned verbatim, no evaluation, no locks). The
  // in-transaction check below stays authoritative against races - two
  // concurrent first-submissions of the same request_id both land here
  // missing, then serialize on the account row lock.
  const preexisting = await findStoredRequest(db, accountId, input.requestId);
  if (preexisting !== null) {
    const result = replayOrConflict(preexisting, input);
    logger.info('consume replay', {
      accountId,
      requestId: input.requestId,
      accepted: result.response.accepted,
    });
    return result;
  }

  try {
    const result = await db.transaction((tx) => consumeInTransaction(tx, accountId, input));
    logger.info('consume decision', {
      accountId,
      userId: input.userId,
      requestId: input.requestId,
      accepted: result.response.accepted,
      units: input.units,
      ms: Math.round((performance.now() - start) * 10) / 10,
    });
    return result;
  } catch (err) {
    // Unreachable while the lock protocol holds - the (account_id, request_id)
    // unique index is a structural backstop. If it ever fires, this losing
    // transaction rolled back atomically (counters untouched), so recovering
    // by replaying the winner is exactly correct.
    if (
      isUniqueViolation(err) &&
      uniqueViolationConstraint(err) === 'requests_account_request_key'
    ) {
      const winner = await findStoredRequest(db, accountId, input.requestId);
      if (winner !== null) {
        const result = replayOrConflict(winner, input);
        logger.warn('consume unique-index backstop fired (lock protocol regression?)', {
          accountId,
          requestId: input.requestId,
        });
        return result;
      }
    }
    throw err;
  }
}

async function consumeInTransaction(
  tx: Tx,
  accountId: string,
  input: ConsumeInput,
): Promise<ConsumeResult> {
  const month = monthStart(new Date());

  // 1. Load the user with their plan, scoped to the calling account - a user
  // id from another account is indistinguishable from a nonexistent one.
  // Done inside the transaction and BEFORE
  // the lazy usage-row
  // insert: that insert carries a foreign key on user_id, and an explicit
  // 404 (not an FK violation) is the contract.
  const userRow = (
    await tx.execute(sql`
      select u.plan_id, p.rules as user_rules, p.scope as user_plan_scope
      from users u
      join plans p on p.id = u.plan_id
      where u.id = ${input.userId} and u.account_id = ${accountId}
    `)
  ).rows[0];
  if (userRow === undefined) throw new NotFoundError('user');
  if (userRow.user_plan_scope !== 'user') {
    // Unreachable through the API (assignment validates scope); a loud
    // invariant tripwire beats silently evaluating the wrong kind of plan.
    throw new Error(
      `user ${input.userId} is assigned a '${String(userRow.user_plan_scope)}'-scoped plan - assignment invariant violated`,
    );
  }

  // The account comes from the verified API key, so this always exists.
  const accountRow = (
    await tx.execute(sql`
      select a.account_plan_id, p.rules as account_rules, p.scope as account_plan_scope
      from accounts a
      join plans p on p.id = a.account_plan_id
      where a.id = ${accountId}
    `)
  ).rows[0];
  if (accountRow === undefined) throw new NotFoundError('account');
  if (accountRow.account_plan_scope !== 'account') {
    throw new Error(
      `account ${accountId} has a '${String(accountRow.account_plan_scope)}'-scoped plan - assignment invariant violated`,
    );
  }

  const userRules = userRow.user_rules as Rules;
  const accountRules = accountRow.account_rules as Rules;
  const userPlanId = String(userRow.plan_id);
  const accountPlanId = String(accountRow.account_plan_id);

  // 2. Lock the account counter row. This is the deliberate per-account
  // serialization point: every consume for one account funnels through it,
  // which is what makes idempotency checks and limit decisions race-free.
  // The row also carries this month's accepted-request count, so the
  // monthly_request_cap rule reads O(1) instead of counting ledger rows.
  // A missing row means zero usage this month: it is created here, under
  // the lock, so only the month's first consume pays for row setup.
  const accountLocked = await lockOrCreateCounter(
    tx,
    'account_usage',
    'account_id',
    accountId,
    month,
  );
  // bigint arrives from the driver as a string - the deliberate conversion point.
  const accountUsed = Number(accountLocked.used_units);
  const accountAcceptedRequests = Number(accountLocked.accepted_requests);

  // 3. Lock the user counter row - ALWAYS after the account row. The fixed
  // global order (account -> user) makes deadlock cycles impossible. Same
  // lazy creation: the row exists from this month's first consume on.
  const userLocked = await lockOrCreateCounter(
    tx,
    'user_usage',
    'user_id',
    input.userId,
    month,
  );
  const userUsed = Number(userLocked.used_units);
  const userAcceptedRequests = Number(userLocked.accepted_requests);

  // 4. Idempotency under lock - the authoritative check. Concurrent
  // duplicates that both missed the fast path serialize here.
  const stored = (
    await tx.execute(sql`
      select user_id, units, response
      from requests
      where account_id = ${accountId} and request_id = ${input.requestId}
    `)
  ).rows[0];
  if (stored !== undefined) {
    return replayOrConflict(
      {
        userId: String(stored.user_id),
        units: Number(stored.units),
        response: stored.response as ConsumeResponseBody,
      },
      input,
    );
  }

  // 5. The pure evaluator - everything above existed to produce this
  // snapshot under lock (src/domain/decision.ts). The accepted-request
  // counts come from the counter rows themselves (incremented on accept,
  // step 6), so no rule ever scans the ledger.
  const decision: Decision = evaluateConsume(
    input.units,
    {
      level: 'account',
      rules: accountRules,
      usedUnits: accountUsed,
      acceptedRequests: accountAcceptedRequests,
    },
    {
      level: 'user',
      rules: userRules,
      usedUnits: userUsed,
      acceptedRequests: userAcceptedRequests,
    },
  );

  // 6. If accepted, consume the FULL amount at both levels (the consume
  // model is all-or-nothing) and count the request once at each level.
  // RETURNING hands back the authoritative post-update totals - no
  // application-side arithmetic, no read-modify-write drift. The CHECK
  // (>= 0) constraints backstop the ledger.
  let accountUsedAfter = accountUsed;
  let userUsedAfter = userUsed;
  if (decision.accepted) {
    const accountUpdated = (
      await tx.execute(sql`
        update account_usage
        set used_units = used_units + ${input.units},
            accepted_requests = accepted_requests + 1,
            updated_at = now()
        where account_id = ${accountId} and month_start = ${month}
        returning used_units
      `)
    ).rows[0];
    if (accountUpdated === undefined) throw new Error('account_usage update matched no rows');
    accountUsedAfter = Number(accountUpdated.used_units);

    const userUpdated = (
      await tx.execute(sql`
        update user_usage
        set used_units = used_units + ${input.units},
            accepted_requests = accepted_requests + 1,
            updated_at = now()
        where user_id = ${input.userId} and month_start = ${month}
        returning used_units
      `)
    ).rows[0];
    if (userUpdated === undefined) throw new Error('user_usage update matched no rows');
    userUsedAfter = Number(userUpdated.used_units);
  }

  // 7. The response body - built once, stored in the ledger, returned to the
  // caller. Replays get this exact object back (content-identical).
  const response: ConsumeResponseBody = {
    request_id: input.requestId,
    accepted: decision.accepted,
    units: input.units,
    units_consumed: decision.accepted ? decision.unitsConsumed : 0,
    reason: decision.accepted ? null : decision.reason,
    all_reasons: decision.accepted ? null : decision.allReasons,
    account: levelState(accountPlanId, accountRules, accountUsedAfter),
    user: levelState(userPlanId, userRules, userUsedAfter),
    evaluated: { account_rules: accountRules, user_rules: userRules },
  };

  // 8. The ledger row: the decision, the rule snapshots it was judged under,
  // and the exact response body. The table's CHECK constraints structurally
  // enforce "a rejection consumes nothing".
  await tx.execute(sql`
    insert into requests
      (account_id, user_id, request_id, units, month_start, accepted, units_consumed,
       rejection_level, rejection_rule, account_plan_id, user_plan_id,
       account_rules, user_rules, response)
    values
      (${accountId}, ${input.userId}, ${input.requestId}, ${input.units}, ${month},
       ${decision.accepted}, ${decision.accepted ? decision.unitsConsumed : 0},
       ${decision.accepted ? null : decision.reason.level},
       ${decision.accepted ? null : decision.reason.rule},
       ${accountPlanId}, ${userPlanId},
       ${accountRules}, ${userRules}, ${response})
  `);

  return { response, replayed: false };
}

/** A locked monthly counter row (bigint columns arrive as strings). */
interface CounterRow {
  used_units: string | bigint;
  accepted_requests: string | bigint;
}

/**
 * Lock this owner's counter row for the month, creating it on the month's
 * first consume. Locking precedes creation, so the common case - the row
 * exists - costs one statement; the first consume of a UTC month pays the
 * extra INSERT ... ON CONFLICT (a concurrent first consume that loses the
 * insert race simply re-locks the winner's row). Table and column names are
 * compile-time constants of this module, never user input.
 */
async function lockOrCreateCounter(
  tx: Tx,
  table: 'account_usage' | 'user_usage',
  ownerColumn: 'account_id' | 'user_id',
  ownerId: string,
  month: string,
): Promise<CounterRow> {
  const lockRow = async (): Promise<CounterRow | undefined> =>
    (
      await tx.execute(sql`
        select used_units, accepted_requests from ${sql.raw(table)}
        where ${sql.raw(ownerColumn)} = ${ownerId} and month_start = ${month}
        for update
      `)
    ).rows[0] as CounterRow | undefined;

  const existing = await lockRow();
  if (existing !== undefined) return existing;

  await tx.execute(sql`
    insert into ${sql.raw(table)} (${sql.raw(ownerColumn)}, month_start, used_units)
    values (${ownerId}, ${month}, 0)
    on conflict do nothing
  `);
  const created = await lockRow();
  if (created === undefined) {
    throw new Error(`${table} row missing after lazy insert`);
  }
  return created;
}

function levelState(planId: string, rules: Rules, used: number): LevelStateDto {
  return {
    plan_id: planId,
    used_units: used,
    // Zero-floor: a downgraded plan never shows negative remaining.
    remaining:
      rules.monthly_allowance === undefined ? null : Math.max(0, rules.monthly_allowance - used),
  };
}

async function findStoredRequest(
  db: Db,
  accountId: string,
  requestId: string,
): Promise<StoredRequest | null> {
  const result = await db.execute(sql`
    select user_id, units, response
    from requests
    where account_id = ${accountId} and request_id = ${requestId}
  `);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    userId: String(row.user_id),
    units: Number(row.units),
    response: row.response as ConsumeResponseBody,
  };
}

/** Same payload -> verbatim replay; different payload -> 409. */
function replayOrConflict(stored: StoredRequest, input: ConsumeInput): ConsumeResult {
  if (stored.userId !== input.userId || stored.units !== input.units) {
    throw new ConflictError(
      'IDEMPOTENCY_CONFLICT',
      `request_id "${input.requestId}" was already used with a different payload`,
    );
  }
  return { response: stored.response, replayed: true };
}
