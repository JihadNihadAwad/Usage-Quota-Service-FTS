import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { DEFAULT_USER_PLAN_ID } from '../db/predefined.js';
import { plans, users } from '../db/schema.js';
import type { Rules } from '../domain/rules/schemas.js';
import { ConflictError, NotFoundError } from '../http/errors.js';
import { isUniqueViolation } from '../lib/pg-errors.js';
import { resolveAssignablePlan, toPlanView, type PlanScope, type PlanView } from './plans.js';

export interface UserView {
  id: string;
  externalId: string;
  plan: PlanView;
  createdAt: Date;
  updatedAt: Date;
}

type UserRow = typeof users.$inferSelect;

function toUserView(row: UserRow, plan: PlanView): UserView {
  return {
    id: row.id,
    externalId: row.externalId,
    plan,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createUser(
  db: Db,
  accountId: string,
  input: { externalId: string; planId?: string },
): Promise<UserView> {
  const plan = await resolveAssignablePlan(
    db,
    accountId,
    input.planId ?? DEFAULT_USER_PLAN_ID,
    'user',
  );
  try {
    const [row] = await db
      .insert(users)
      .values({ accountId, externalId: input.externalId, planId: plan.id })
      .returning();
    if (row === undefined) throw new Error('user insert returned no row');
    return toUserView(row, plan);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(
        'USER_ALREADY_EXISTS',
        `user "${input.externalId}" already exists in this account`,
      );
    }
    throw err;
  }
}

export async function listUsers(db: Db, accountId: string): Promise<UserView[]> {
  const rows = await db
    .select({ user: users, plan: plans })
    .from(users)
    .innerJoin(plans, eq(users.planId, plans.id))
    .where(eq(users.accountId, accountId))
    .orderBy(desc(users.createdAt), desc(users.id));
  return rows.map((row) => toUserView(row.user, toPlanView(row.plan)));
}

/** Scoped fetch. A foreign account's user id is indistinguishable from a
 *  nonexistent one - same 404. */
export async function getUser(db: Db, accountId: string, userId: string): Promise<UserView> {
  const [row] = await db
    .select({ user: users, plan: plans })
    .from(users)
    .innerJoin(plans, eq(users.planId, plans.id))
    .where(and(eq(users.id, userId), eq(users.accountId, accountId)))
    .limit(1);
  if (row === undefined) throw new NotFoundError('user');
  return toUserView(row.user, toPlanView(row.plan));
}

/** Assign a different plan to a user. Usage counters are untouched. */
export async function updateUserPlan(
  db: Db,
  accountId: string,
  userId: string,
  planId: string,
): Promise<UserView> {
  const plan = await resolveAssignablePlan(db, accountId, planId, 'user');
  const [row] = await db
    .update(users)
    .set({ planId: plan.id, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.accountId, accountId)))
    .returning();
  if (row === undefined) throw new NotFoundError('user');
  return toUserView(row, plan);
}
