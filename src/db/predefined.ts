import type { Rules } from '../domain/rules/schemas.js';

// The predefined plans (brief: ready-to-use plans present "when the service starts").
// The ids are fixed, deliberately memorable UUIDs so the README,
// the demo client, and psql can hard-reference them. The seed upserts by id,
// so these are stable forever.

export type { Rules };

export type PredefinedPlan = {
  id: string;
  name: string;
  scope: 'account' | 'user';
  rules: Rules;
};

export const STARTER_PLAN_ID = '11111111-1111-4111-8111-111111111111';
export const PRO_PLAN_ID = '22222222-2222-4222-8222-222222222222';
export const BASIC_PLAN_ID = '33333333-3333-4333-8333-333333333333';
export const PREMIUM_PLAN_ID = '44444444-4444-4444-8444-444444444444';

export const PREDEFINED_PLANS: readonly PredefinedPlan[] = [
  {
    id: STARTER_PLAN_ID,
    name: 'Starter',
    scope: 'account',
    rules: { monthly_allowance: 10_000, max_per_request: 100 },
  },
  {
    id: PRO_PLAN_ID,
    name: 'Pro',
    scope: 'account',
    rules: { monthly_allowance: 100_000, max_per_request: 1_000 },
  },
  {
    id: BASIC_PLAN_ID,
    name: 'Basic',
    scope: 'user',
    rules: { monthly_allowance: 1_000, max_per_request: 20 },
  },
  {
    id: PREMIUM_PLAN_ID,
    name: 'Premium',
    scope: 'user',
    rules: { monthly_allowance: 10_000, max_per_request: 100 },
  },
];

// API defaults when a caller doesn't pick a plan (used by the HTTP routes).
export const DEFAULT_ACCOUNT_PLAN_ID = STARTER_PLAN_ID;
export const DEFAULT_USER_PLAN_ID = BASIC_PLAN_ID;
