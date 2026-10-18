import { orderFailures } from './precedence.js';
import { RULES } from './rules/registry.js';
import type { Rules } from './rules/schemas.js';
import type { RuleFailure, RuleLevel } from './rules/types.js';

/**
 * The state one level brings to a consume evaluation. The consume
 * transaction loads this snapshot under the row locks; this module stays
 * pure - the entire quota decision is a pure function of this snapshot plus
 * the request.
 */
export interface LevelContext {
  level: RuleLevel;
  rules: Rules;
  /** units already consumed this month at this level */
  usedUnits: number;
  /** accepted requests this month at this level */
  acceptedRequests: number;
}

/**
 * The consume decision. Acceptance consumes the full amount (all-or-nothing).
 * A rejection consumes nothing - structurally: the rejected branch does not
 * carry a `unitsConsumed` field at all.
 */
export type Decision =
  | { accepted: true; units: number; unitsConsumed: number }
  | { accepted: false; units: number; reason: RuleFailure; allReasons: RuleFailure[] };

/**
 * Evaluate a consume request against both plans. Every rule configured on
 * either plan is checked; an unconfigured rule imposes no constraint.
 * Both plans must allow the request. Pure: reads the contexts, mutates
 * nothing, performs no IO.
 */
export function evaluateConsume(
  units: number,
  account: LevelContext,
  user: LevelContext,
): Decision {
  const failures: RuleFailure[] = [];

  for (const level of [user, account]) {
    for (const rule of RULES.values()) {
      const config = level.rules[rule.id];
      if (config === undefined) continue; // rule not configured on this plan
      const failure = rule.evaluate({
        level: level.level,
        requestedUnits: units,
        usedUnits: level.usedUnits,
        acceptedRequests: level.acceptedRequests,
        config,
      });
      if (failure) failures.push(failure);
    }
  }

  if (failures.length === 0) {
    return { accepted: true, units, unitsConsumed: units };
  }

  const ordered = orderFailures(failures);
  const primary = ordered[0];
  if (primary === undefined) {
    // Unreachable (failures is non-empty), but a wrong primary reason would
    // corrupt every rejection response - fail loudly instead of guessing.
    throw new Error('evaluateConsume: denials exist but none survived ordering');
  }
  return { accepted: false, units, reason: primary, allReasons: ordered };
}
