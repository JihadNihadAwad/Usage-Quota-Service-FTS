import { z } from 'zod';
import {
  MAX_RULE_VALUE,
  type RuleDefinition,
  type RuleEvaluationContext,
  type RuleFailure,
} from './types.js';

/**
 * monthly_request_cap - a third rule beyond the two required ones, built
 * the same way as the others to show what adding a rule looks like:
 * the maximum number of accepted requests per UTC month, independent of
 * units. Stateful: counts accepted requests this month at the level (the
 * consume transaction reads the count off the usage counter rows).
 *
 * Interaction with account/user plans: identical to the other rules - the
 * user cap counts the user's accepted requests, the account cap counts all
 * accepted requests across the account's users; both must allow the request.
 */
export const MonthlyRequestCapRule: RuleDefinition = {
  id: 'monthly_request_cap',
  configSchema: z.number().int().min(1).max(MAX_RULE_VALUE),
  evaluate(ctx: RuleEvaluationContext): RuleFailure | null {
    // This request would be accepted request #acceptedRequests + 1.
    if (ctx.acceptedRequests < ctx.config) return null;
    return {
      level: ctx.level,
      rule: 'monthly_request_cap',
      message: `accepting would make ${ctx.acceptedRequests + 1} accepted requests this month; ${ctx.level} plan caps at ${ctx.config}`,
    };
  },
};
