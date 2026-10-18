import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { DEFAULT_ACCOUNT_PLAN_ID } from '../db/predefined.js';
import { accounts, apiKeys, plans } from '../db/schema.js';
import { NotFoundError } from '../http/errors.js';
import { generateApiKey } from '../lib/keygen.js';
import { resolveAssignablePlan, type PlanScope, type PlanView } from './plans.js';

export interface AccountView {
  id: string;
  name: string;
  plan: PlanView;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatedAccount {
  account: AccountView;
  apiKey: {
    key: string; // plaintext - shown exactly once, never stored
    keyPrefix: string;
    createdAt: Date;
  };
}

function planFromJoinedRow(row: typeof plans.$inferSelect): PlanView {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope as PlanScope,
    rules: row.rules,
    predefined: row.accountId === null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Bootstrap: create an account with its plan and its first API key, in one
 * transaction. The plaintext key is returned once and never stored.
 */
export async function createAccount(
  db: Db,
  input: { name: string; accountPlanId?: string },
): Promise<CreatedAccount> {
  const plan = await resolveAssignablePlan(
    db,
    null,
    input.accountPlanId ?? DEFAULT_ACCOUNT_PLAN_ID,
    'account',
  );
  const { key, keyHash, keyPrefix } = generateApiKey();

  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(accounts)
      .values({ name: input.name, accountPlanId: plan.id })
      .returning();
    if (account === undefined) throw new Error('account insert returned no row');

    const [keyRow] = await tx
      .insert(apiKeys)
      .values({ accountId: account.id, keyHash, keyPrefix })
      .returning();
    if (keyRow === undefined) throw new Error('api key insert returned no row');

    return {
      account: {
        id: account.id,
        name: account.name,
        plan,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      },
      apiKey: { key, keyPrefix: keyRow.keyPrefix, createdAt: keyRow.createdAt },
    };
  });
}

export async function getAccount(db: Db, accountId: string): Promise<AccountView> {
  const [row] = await db
    .select({ account: accounts, plan: plans })
    .from(accounts)
    .innerJoin(plans, eq(accounts.accountPlanId, plans.id))
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (row === undefined) throw new NotFoundError('account');
  return {
    id: row.account.id,
    name: row.account.name,
    plan: planFromJoinedRow(row.plan),
    createdAt: row.account.createdAt,
    updatedAt: row.account.updatedAt,
  };
}

/** Switch the account's plan. Usage counters are untouched - switching never
 *  grants a fresh allowance (brief: plan-change semantics). */
export async function updateAccountPlan(
  db: Db,
  accountId: string,
  planId: string,
): Promise<AccountView> {
  const plan = await resolveAssignablePlan(db, accountId, planId, 'account');
  const [row] = await db
    .update(accounts)
    .set({ accountPlanId: plan.id, updatedAt: new Date() })
    .where(eq(accounts.id, accountId))
    .returning();
  if (row === undefined) throw new NotFoundError('account');
  return {
    id: row.id,
    name: row.name,
    plan,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
