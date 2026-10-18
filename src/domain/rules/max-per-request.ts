import { z } from 'zod';
import {
  MAX_RULE_VALUE,
  type RuleDefinition,
  type RuleEvaluationContext,
  type RuleFailure,
} from './types.js';

/**
 * max_per_request - the largest amount consumable in a single request
 * (one of the two required rule types, at both plan levels).
 * Stateless: the decision needs no usage data, only the request itself.
 */
export const MaxPerRequestRule: RuleDefinition = {
  id: 'max_per_request',
  configSchema: z.number().int().min(1).max(MAX_RULE_VALUE),
  evaluate(ctx: RuleEvaluationContext): RuleFailure | null {
    if (ctx.requestedUnits <= ctx.config) return null;
    return {
      level: ctx.level,
      rule: 'max_per_request',
      message: `requested ${ctx.requestedUnits} units; ${ctx.level} plan allows at most ${ctx.config} per request`,
    };
  },
};
