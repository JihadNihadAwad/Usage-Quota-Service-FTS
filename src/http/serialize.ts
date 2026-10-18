import type { AccountView, CreatedAccount } from '../services/accounts.js';
import type { PlanView } from '../services/plans.js';
import type { UserView } from '../services/users.js';
import type { UsageView } from '../services/usage.js';
import type { HistoryItem } from '../services/history.js';

// Outward-facing response shapes: snake_case fields, ISO-8601 UTC timestamps.
// One place to look, so the wire format stays consistent everywhere.

export function serializePlan(plan: PlanView) {
  return {
    id: plan.id,
    name: plan.name,
    scope: plan.scope,
    rules: plan.rules,
    predefined: plan.predefined,
    created_at: plan.createdAt.toISOString(),
    updated_at: plan.updatedAt.toISOString(),
  };
}

export function serializeAccount(account: AccountView) {
  return {
    id: account.id,
    name: account.name,
    plan: serializePlan(account.plan),
    created_at: account.createdAt.toISOString(),
    updated_at: account.updatedAt.toISOString(),
  };
}

export function serializeCreatedAccount(created: CreatedAccount) {
  return {
    account: serializeAccount(created.account),
    api_key: {
      key: created.apiKey.key,
      key_prefix: created.apiKey.keyPrefix,
      created_at: created.apiKey.createdAt.toISOString(),
    },
  };
}

export function serializeUser(user: UserView) {
  return {
    id: user.id,
    external_id: user.externalId,
    plan: serializePlan(user.plan),
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString(),
  };
}

export function serializeUsage(usage: UsageView) {
  return {
    month: usage.month,
    used_units: usage.usedUnits,
    allowance: usage.allowance,
    remaining: usage.remaining,
    plan: serializePlan(usage.plan),
  };
}

export function serializeHistoryItem(item: HistoryItem) {
  return {
    id: item.id,
    request_id: item.requestId,
    user_id: item.userId,
    units: item.units,
    accepted: item.accepted,
    units_consumed: item.unitsConsumed,
    rejection: item.rejection,
    month: item.month,
    created_at: item.createdAt.toISOString(),
  };
}
