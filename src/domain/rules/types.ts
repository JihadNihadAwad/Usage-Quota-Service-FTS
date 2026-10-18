import type { z } from 'zod';

/** The plan level a rule applies at. */
export type RuleLevel = 'account' | 'user';

/**
 * Rule ids - the registry keys. Adding a rule is: one id here, one file
 * implementing RuleDefinition, one registration line, one precedence slot.
 * The evaluator and the HTTP layer never change.
 */
export type RuleId = 'max_per_request' | 'monthly_allowance' | 'monthly_request_cap';

/** Upper bound for any configured rule value (units capped at the same 1e12 bound). */
export const MAX_RULE_VALUE = 1_000_000_000_000;

/** One way a request can be denied. `message` is safe to show a caller. */
export interface RuleFailure {
  level: RuleLevel;
  rule: RuleId;
  message: string;
}

/**
 * Everything a rule may look at. The state fields are loaded by the caller -
 * the consume transaction loads them, under the row locks -
 * so rules themselves stay pure: same input, same answer, no side effects.
 */
export interface RuleEvaluationContext {
  level: RuleLevel;
  /** units the caller wants to consume (integer > 0, validated upstream) */
  requestedUnits: number;
  /** units already consumed this month at this level */
  usedUnits: number;
  /** accepted requests this month at this level */
  acceptedRequests: number;
  /** this rule's configured value on the plan being evaluated */
  config: number;
}

/** A rule: the config schema for its key (plan create/update boundary) + pure evaluation. */
export interface RuleDefinition {
  id: RuleId;
  configSchema: z.ZodType<number>;
  /** null = request passes this rule; RuleFailure = the denial. */
  evaluate(ctx: RuleEvaluationContext): RuleFailure | null;
}
