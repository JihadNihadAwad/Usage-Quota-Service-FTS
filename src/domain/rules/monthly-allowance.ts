import { z } from 'zod';
import {
  MAX_RULE_VALUE,
  type RuleDefinition,
  type RuleEvaluationContext,
  type RuleFailure,
} from './types.js';

/**
 * monthly_allowance - total units available during a UTC calendar month
 * (the other required rule type, at both plan levels).
 * Stateful: compares the request against `allowance - used`.
 *
 * The zero-floor (Math.max(0, ...)) covers downgrades: when a plan is cut
 * below current usage, remaining reads 0 (never negative) and consumption
 * at that level is rejected until the month rolls over or the allowance
 * is raised. Config value 0 is valid and means the level is blocked entirely.
 */
export const MonthlyAllowanceRule: RuleDefinition = {
  id: 'monthly_allowance',
  configSchema: z.number().int().min(0).max(MAX_RULE_VALUE),
  evaluate(ctx: RuleEvaluationContext): RuleFailure | null {
    const remaining = Math.max(0, ctx.config - ctx.usedUnits);
    if (ctx.requestedUnits <= remaining) return null;
    return {
      level: ctx.level,
      rule: 'monthly_allowance',
      message: `requested ${ctx.requestedUnits} units; ${ctx.level} plan has ${remaining} of ${ctx.config} remaining this month (${ctx.usedUnits} already used)`,
    };
  },
};
