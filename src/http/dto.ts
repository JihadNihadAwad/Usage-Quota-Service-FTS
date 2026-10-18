import { z } from 'zod';
import { RulesSchema } from '../domain/rules/schemas.js';
import { MAX_RULE_VALUE } from '../domain/rules/types.js';

// Every external input is parsed at the route level, strictly: unknown keys
// are typos and fail loudly rather than being silently ignored (decision
// #24). Bodies, params, and queries all use the same mechanism.

const uuid = z.uuid();
const label = z.string().min(1).max(200);

export const CreateAccountBody = z.strictObject({
  name: label,
  account_plan_id: uuid.optional(),
});
export type CreateAccountInput = z.infer<typeof CreateAccountBody>;

export const UpdateAccountBody = z.strictObject({
  account_plan_id: uuid,
});
export type UpdateAccountInput = z.infer<typeof UpdateAccountBody>;

export const CreateUserBody = z.strictObject({
  external_id: label,
  plan_id: uuid.optional(),
});
export type CreateUserInput = z.infer<typeof CreateUserBody>;

export const UpdateUserBody = z.strictObject({
  plan_id: uuid,
});
export type UpdateUserInput = z.infer<typeof UpdateUserBody>;

export const PlanScope = z.enum(['account', 'user']);

export const CreatePlanBody = z.strictObject({
  name: label,
  scope: PlanScope,
  rules: RulesSchema,
});
export type CreatePlanInput = z.infer<typeof CreatePlanBody>;

export const UpdatePlanBody = z
  .strictObject({
    name: label.optional(),
    rules: RulesSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.rules !== undefined, {
    message: 'provide at least one of: name, rules',
  });
export type UpdatePlanInput = z.infer<typeof UpdatePlanBody>;

export const ConsumeBody = z.strictObject({
  user_id: uuid,
  request_id: z.string().min(1).max(200),
  // Positive whole number; the 1e12 cap matches the rule-config bound so a
  // request can never exceed every representable allowance (assumption #14).
  units: z.number().int().min(1).max(MAX_RULE_VALUE),
});
export type ConsumeInput = z.infer<typeof ConsumeBody>;

const monthString = z.string().regex(/^\d{4}-\d{2}$/, 'month must be formatted YYYY-MM');

export const MonthQuery = z.strictObject({
  month: monthString.optional(),
});
export type MonthQueryInput = z.infer<typeof MonthQuery>;

export const ScopeQuery = z.strictObject({
  scope: PlanScope.optional(),
});
export type ScopeQueryInput = z.infer<typeof ScopeQuery>;

const historyQueryShape = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(500).optional(),
  month: monthString.optional(),
  outcome: z.enum(['accepted', 'rejected']).optional(),
};

// The account-wide history also allows a user_id filter; the user-scoped
// route takes the user from the path instead, so it does not accept one.
export const HistoryQuery = z.strictObject({
  ...historyQueryShape,
  user_id: uuid.optional(),
});
export type HistoryQueryInput = z.infer<typeof HistoryQuery>;

export const UserHistoryQuery = z.strictObject(historyQueryShape);
export type UserHistoryQueryInput = z.infer<typeof UserHistoryQuery>;

export const IdParam = z.strictObject({
  id: uuid,
});
export type IdParamInput = z.infer<typeof IdParam>;
