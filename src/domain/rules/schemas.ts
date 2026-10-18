import { z } from 'zod';
import { MaxPerRequestRule } from './max-per-request.js';
import { MonthlyAllowanceRule } from './monthly-allowance.js';
import { MonthlyRequestCapRule } from './monthly-request-cap.js';

/**
 * The shape stored in plans.rules (JSONB), validated whenever a plan is
 * created or updated through the API.
 *
 * Strict: an unknown key is a typo and must fail loudly, not be silently
 * stored and then ignored. At least one rule must be configured - a plan
 * that limits nothing is almost certainly a mistake (an allowance of 0
 * expresses "blocked at this level" when that is genuinely wanted).
 */
export const RulesSchema = z
  .strictObject({
    max_per_request: MaxPerRequestRule.configSchema.optional(),
    monthly_allowance: MonthlyAllowanceRule.configSchema.optional(),
    monthly_request_cap: MonthlyRequestCapRule.configSchema.optional(),
  })
  .refine((rules) => Object.keys(rules).length > 0, {
    message: 'a plan must configure at least one rule',
  });

export type Rules = z.infer<typeof RulesSchema>;
