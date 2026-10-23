import { MaxPerRequestRule } from './max-per-request.js';
import { MonthlyAllowanceRule } from './monthly-allowance.js';
import { MonthlyRequestCapRule } from './monthly-request-cap.js';
import type { RuleDefinition, RuleId } from './types.js';

/**
 * The rule registry. Adding a rule is one file implementing
 * RuleDefinition, one line here, and one precedence slot in precedence.ts.
 * The evaluator (decision.ts) and the HTTP layer iterate the registry and
 * don't change.
 */
export const RULES: ReadonlyMap<RuleId, RuleDefinition> = new Map<RuleId, RuleDefinition>([
  [MaxPerRequestRule.id, MaxPerRequestRule],
  [MonthlyAllowanceRule.id, MonthlyAllowanceRule],
  [MonthlyRequestCapRule.id, MonthlyRequestCapRule],
]);
