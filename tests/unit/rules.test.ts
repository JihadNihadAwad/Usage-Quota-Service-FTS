import { describe, expect, it } from 'vitest';
import { MaxPerRequestRule } from '../../src/domain/rules/max-per-request.js';
import { MonthlyAllowanceRule } from '../../src/domain/rules/monthly-allowance.js';
import { MonthlyRequestCapRule } from '../../src/domain/rules/monthly-request-cap.js';
import { RULES } from '../../src/domain/rules/registry.js';
import { RulesSchema } from '../../src/domain/rules/schemas.js';
import type { RuleEvaluationContext } from '../../src/domain/rules/types.js';

const ctx = (overrides: Partial<RuleEvaluationContext> = {}): RuleEvaluationContext => ({
  level: 'user',
  requestedUnits: 10,
  usedUnits: 0,
  acceptedRequests: 0,
  config: 100,
  ...overrides,
});

describe('max_per_request', () => {
  it('passes when units equal the configured max', () => {
    expect(MaxPerRequestRule.evaluate(ctx({ requestedUnits: 100, config: 100 }))).toBeNull();
  });

  it('fails one unit over the max, identifying rule and level', () => {
    const failure = MaxPerRequestRule.evaluate(ctx({ requestedUnits: 101, config: 100 }));
    expect(failure).toMatchObject({ level: 'user', rule: 'max_per_request' });
    expect(failure?.message).toContain('100');
    expect(failure?.message).toContain('101');
  });
});

describe('monthly_allowance', () => {
  it('passes while the request fits within the remaining allowance', () => {
    expect(
      MonthlyAllowanceRule.evaluate(ctx({ requestedUnits: 10, usedUnits: 90, config: 100 })),
    ).toBeNull();
  });

  it('fails when the request exceeds the remaining allowance', () => {
    const failure = MonthlyAllowanceRule.evaluate(
      ctx({ requestedUnits: 10, usedUnits: 95, config: 100 }),
    );
    expect(failure).toMatchObject({ rule: 'monthly_allowance', level: 'user' });
    expect(failure?.message).toContain('5');
  });

  it('zero-floors remaining after a downgrade below current usage', () => {
    // Used 150 of a 100 allowance (plan downgraded mid-month): remaining is
    // 0 - never negative - and any further consumption at this level fails.
    const failure = MonthlyAllowanceRule.evaluate(
      ctx({ requestedUnits: 1, usedUnits: 150, config: 100 }),
    );
    expect(failure).not.toBeNull();
    expect(failure?.message).toContain('0 of 100');
  });

  it('treats allowance 0 as a blocked level', () => {
    expect(MonthlyAllowanceRule.evaluate(ctx({ requestedUnits: 1, config: 0 }))).not.toBeNull();
  });
});

describe('monthly_request_cap', () => {
  it('passes while the next accepted request stays within the cap', () => {
    expect(MonthlyRequestCapRule.evaluate(ctx({ acceptedRequests: 9, config: 10 }))).toBeNull();
  });

  it('fails when the next accepted request would exceed the cap', () => {
    const failure = MonthlyRequestCapRule.evaluate(ctx({ acceptedRequests: 10, config: 10 }));
    expect(failure).toMatchObject({ rule: 'monthly_request_cap', level: 'user' });
    expect(failure?.message).toContain('11');
  });
});

describe('rule registry', () => {
  it('contains exactly the three known rules, keyed by id', () => {
    expect([...RULES.keys()].sort()).toEqual([
      'max_per_request',
      'monthly_allowance',
      'monthly_request_cap',
    ]);
  });
});

describe('RulesSchema (plan create/update boundary)', () => {
  it('accepts any non-empty subset of known rules', () => {
    expect(RulesSchema.parse({ monthly_allowance: 1000 })).toEqual({ monthly_allowance: 1000 });
    expect(
      RulesSchema.parse({
        monthly_allowance: 1000,
        max_per_request: 20,
        monthly_request_cap: 50,
      }),
    ).toEqual({ monthly_allowance: 1000, max_per_request: 20, monthly_request_cap: 50 });
  });

  it('accepts allowance 0 (a blocked level) but rejects zero per-request/cap configs', () => {
    expect(RulesSchema.parse({ monthly_allowance: 0 })).toEqual({ monthly_allowance: 0 });
    expect(RulesSchema.safeParse({ max_per_request: 0 }).success).toBe(false);
    expect(RulesSchema.safeParse({ monthly_request_cap: 0 }).success).toBe(false);
  });

  it('rejects fractional, negative, and oversized values', () => {
    expect(RulesSchema.safeParse({ max_per_request: 1.5 }).success).toBe(false);
    expect(RulesSchema.safeParse({ monthly_allowance: -1 }).success).toBe(false);
    expect(RulesSchema.safeParse({ max_per_request: 1e13 }).success).toBe(false);
  });

  it('rejects unknown keys - typos must fail loudly, not store silently', () => {
    expect(RulesSchema.safeParse({ monthly_alowance: 100 }).success).toBe(false);
  });

  it('rejects an empty ruleset - a plan must limit something', () => {
    expect(RulesSchema.safeParse({}).success).toBe(false);
  });
});
