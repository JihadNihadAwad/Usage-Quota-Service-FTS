import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { accountUsage, userUsage } from '../db/schema.js';
import { getAccount } from './accounts.js';
import { getUser } from './users.js';
import type { PlanView } from './plans.js';

export interface UsageView {
  month: string; // month_start date, 'YYYY-MM-01'
  usedUnits: number;
  plan: PlanView;
  /** null = the plan configures no monthly_allowance rule at this level. */
  allowance: number | null;
  /** max(0, allowance - used) - the zero-floor for downgrades; null when allowance is. */
  remaining: number | null;
}

function toUsageView(monthStart: string, usedUnits: number, plan: PlanView): UsageView {
  const allowance = plan.rules.monthly_allowance ?? null;
  const remaining = allowance === null ? null : Math.max(0, allowance - usedUnits);
  return { month: monthStart, usedUnits, plan, allowance, remaining };
}

/** Current-month usage for the calling account. A missing counter row
 *  reads as zero usage. */
export async function getAccountUsage(
  db: Db,
  accountId: string,
  monthStart: string,
): Promise<UsageView> {
  const account = await getAccount(db, accountId);
  const [row] = await db
    .select()
    .from(accountUsage)
    .where(and(eq(accountUsage.accountId, accountId), eq(accountUsage.monthStart, monthStart)))
    .limit(1);
  return toUsageView(monthStart, row?.usedUnits ?? 0, account.plan);
}

export async function getUserUsage(
  db: Db,
  accountId: string,
  userId: string,
  monthStart: string,
): Promise<UsageView> {
  const user = await getUser(db, accountId, userId); // 404 masking included
  const [row] = await db
    .select()
    .from(userUsage)
    .where(and(eq(userUsage.userId, userId), eq(userUsage.monthStart, monthStart)))
    .limit(1);
  return toUsageView(monthStart, row?.usedUnits ?? 0, user.plan);
}
