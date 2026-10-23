import type { RuleFailure, RuleId, RuleLevel } from './rules/types.js';

/**
 * Primary-reason order when several rules deny the same request.
 * Order rationale: stateless denials first (no counters involved), user
 * before account (the more specific plan speaks first), per-request rules
 * before monthly ones. The response carries the primary reason plus the
 * full ordered failure list.
 */
export const PRECEDENCE: ReadonlyArray<{ level: RuleLevel; rule: RuleId }> = [
  { level: 'user', rule: 'max_per_request' },
  { level: 'account', rule: 'max_per_request' },
  { level: 'user', rule: 'monthly_allowance' },
  { level: 'user', rule: 'monthly_request_cap' },
  { level: 'account', rule: 'monthly_allowance' },
  { level: 'account', rule: 'monthly_request_cap' },
];

function rank(failure: RuleFailure): number {
  const index = PRECEDENCE.findIndex(
    (slot) => slot.level === failure.level && slot.rule === failure.rule,
  );
  return index === -1 ? PRECEDENCE.length : index; // unknown combos sort last (defensive)
}

/** Orders denials by precedence; the first entry is the primary reason. */
export function orderFailures(failures: RuleFailure[]): RuleFailure[] {
  return [...failures].sort((a, b) => rank(a) - rank(b));
}
