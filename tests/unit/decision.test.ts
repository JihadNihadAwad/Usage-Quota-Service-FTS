import { describe, expect, it } from 'vitest';
import { evaluateConsume, type LevelContext } from '../../src/domain/decision.js';

// The example scenario: an account 10,000/mo + 100/req,
// user 1,000/mo + 20/req.
const ACCOUNT: LevelContext = {
  level: 'account',
  rules: { monthly_allowance: 10_000, max_per_request: 100 },
  usedUnits: 0,
  acceptedRequests: 0,
};

const USER: LevelContext = {
  level: 'user',
  rules: { monthly_allowance: 1_000, max_per_request: 20 },
  usedUnits: 0,
  acceptedRequests: 0,
};

describe('evaluateConsume - the example scenario', () => {
  it('accepts 10 units when both plans allow, consuming the full amount', () => {
    expect(evaluateConsume(10, ACCOUNT, USER)).toEqual({
      accepted: true,
      units: 10,
      unitsConsumed: 10,
    });
  });

  it('rejects 25 units by the user per-request limit even though allowances suffice', () => {
    const decision = evaluateConsume(25, ACCOUNT, USER);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.reason).toMatchObject({ level: 'user', rule: 'max_per_request' });
      expect(decision.allReasons).toHaveLength(1);
    }
  });

  it('rejects a 10-unit request when the account has only 5 remaining, even though the user has plenty', () => {
    const decision = evaluateConsume(10, { ...ACCOUNT, usedUnits: 9_995 }, USER);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.reason).toMatchObject({ level: 'account', rule: 'monthly_allowance' });
    }
  });
});

describe('evaluateConsume - precedence and coverage', () => {
  const TIGHT_USER: LevelContext = {
    level: 'user',
    rules: { max_per_request: 1, monthly_allowance: 1, monthly_request_cap: 1 },
    usedUnits: 5,
    acceptedRequests: 5,
  };
  const TIGHT_ACCOUNT: LevelContext = {
    level: 'account',
    rules: { max_per_request: 1, monthly_allowance: 1, monthly_request_cap: 1 },
    usedUnits: 5,
    acceptedRequests: 5,
  };

  it('reports every failing rule, ordered by the documented precedence', () => {
    const decision = evaluateConsume(50, TIGHT_ACCOUNT, TIGHT_USER);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.allReasons.map((f) => `${f.level}.${f.rule}`)).toEqual([
        'user.max_per_request',
        'account.max_per_request',
        'user.monthly_allowance',
        'user.monthly_request_cap',
        'account.monthly_allowance',
        'account.monthly_request_cap',
      ]);
      expect(decision.reason).toBe(decision.allReasons[0]);
    }
  });

  it('skips rules the plan does not configure', () => {
    const minimal: LevelContext = {
      level: 'user',
      rules: { monthly_allowance: 1_000 },
      usedUnits: 0,
      acceptedRequests: 0,
    };
    // No max_per_request on the user plan: 50 units passes that plan.
    expect(evaluateConsume(50, ACCOUNT, minimal).accepted).toBe(true);
  });

  it('rejects when the extra rule (monthly_request_cap) is the only thing standing in the way', () => {
    const capped: LevelContext = {
      level: 'user',
      rules: { monthly_allowance: 1_000, max_per_request: 100, monthly_request_cap: 5 },
      usedUnits: 10,
      acceptedRequests: 5,
    };
    const decision = evaluateConsume(1, ACCOUNT, capped);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.reason).toMatchObject({ level: 'user', rule: 'monthly_request_cap' });
      expect(decision.allReasons).toHaveLength(1);
    }
  });
});

describe('evaluateConsume - purity and decision shape', () => {
  it('never mutates the contexts it reads', () => {
    const account: LevelContext = {
      ...ACCOUNT,
      rules: { ...ACCOUNT.rules },
      usedUnits: 9_995,
    };
    const user: LevelContext = { ...USER, rules: { ...USER.rules } };
    const before = structuredClone({ account, user });
    evaluateConsume(25, account, user);
    expect({ account, user }).toEqual(before);
  });

  it('rejected decisions carry no unitsConsumed (a rejection consumes nothing)', () => {
    const decision = evaluateConsume(25, ACCOUNT, USER);
    expect(decision.accepted).toBe(false);
    expect(decision).not.toHaveProperty('unitsConsumed');
  });
});
