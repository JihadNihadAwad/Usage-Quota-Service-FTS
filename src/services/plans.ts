import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { plans } from '../db/schema.js';
import type { Rules } from '../domain/rules/schemas.js';
import { ApiError, ConflictError, ForbiddenError, NotFoundError } from '../http/errors.js';
import { isUniqueViolation } from '../lib/pg-errors.js';

export type PlanRow = typeof plans.$inferSelect;
export type PlanScope = 'account' | 'user';

export interface PlanView {
  id: string;
  name: string;
  scope: PlanScope;
  rules: Rules;
  predefined: boolean; // account_id is null - platform-owned, read-only
  createdAt: Date;
  updatedAt: Date;
}

export function toPlanView(row: PlanRow): PlanView {
  return {
    id: row.id,
    name: row.name,
    // The plans_scope_ck CHECK constraint guarantees the two values at the
    // database level; the cast just narrows the text column for TypeScript.
    scope: row.scope as PlanScope,
    rules: row.rules,
    predefined: row.accountId === null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Plans visible to an account: the predefined catalog plus its own custom plans. */
export async function listPlans(db: Db, accountId: string, scope?: PlanScope): Promise<PlanView[]> {
  const ownerFilter = or(isNull(plans.accountId), eq(plans.accountId, accountId));
  const where = scope === undefined ? ownerFilter : and(ownerFilter, eq(plans.scope, scope));
  const rows = await db
    .select()
    .from(plans)
    .where(where)
    .orderBy(asc(plans.createdAt), asc(plans.name));
  return rows.map(toPlanView);
}

export async function createPlan(
  db: Db,
  accountId: string,
  input: { name: string; scope: PlanScope; rules: Rules },
): Promise<PlanView> {
  try {
    const [row] = await db
      .insert(plans)
      .values({ accountId, name: input.name, scope: input.scope, rules: input.rules })
      .returning();
    if (row === undefined) throw new Error('plan insert returned no row');
    return toPlanView(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(
        'PLAN_NAME_TAKEN',
        `a ${input.scope} plan named "${input.name}" already exists`,
      );
    }
    throw err;
  }
}

export async function updatePlan(
  db: Db,
  accountId: string,
  planId: string,
  input: { name?: string; rules?: Rules },
): Promise<PlanView> {
  const existing = await getOwnedOrPredefinedPlan(db, accountId, planId);
  if (existing.accountId === null) {
    throw new ForbiddenError('PLAN_IMMUTABLE', 'predefined plans are read-only');
  }
  try {
    const [row] = await db
      .update(plans)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.rules !== undefined && { rules: input.rules }),
        updatedAt: new Date(),
      })
      .where(eq(plans.id, planId))
      .returning();
    if (row === undefined) throw new NotFoundError('plan');
    return toPlanView(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(
        'PLAN_NAME_TAKEN',
        `a ${existing.scope} plan with that name already exists`,
      );
    }
    throw err;
  }
}

/**
 * A plan this account may assign: any predefined plan, or a custom plan it
 * owns. A foreign account's custom plan id is indistinguishable from a
 * nonexistent one (404).
 */
async function getOwnedOrPredefinedPlan(db: Db, accountId: string, planId: string) {
  const [row] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), or(isNull(plans.accountId), eq(plans.accountId, accountId))))
    .limit(1);
  if (row === undefined) throw new NotFoundError('plan');
  return row;
}

/**
 * Validation for plan ASSIGNMENT (accounts choosing their account plan,
 * users' plans). Checks existence, ownership, and scope match.
 * accountId null = bootstrap (no account exists yet) - only predefined plans
 * qualify, which is exactly what a brand-new account can reference.
 */
export async function resolveAssignablePlan(
  db: Db,
  accountId: string | null,
  planId: string,
  scope: PlanScope,
): Promise<PlanView> {
  const ownerFilter =
    accountId === null
      ? isNull(plans.accountId)
      : or(isNull(plans.accountId), eq(plans.accountId, accountId));
  const [row] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), ownerFilter))
    .limit(1);
  if (row === undefined) throw new NotFoundError('plan');
  const view = toPlanView(row);
  if (view.scope !== scope) {
    throw new ApiError(
      400,
      'PLAN_SCOPE_MISMATCH',
      `plan ${view.id} is scoped '${view.scope}' but a '${scope}' plan is required`,
    );
  }
  return view;
}
