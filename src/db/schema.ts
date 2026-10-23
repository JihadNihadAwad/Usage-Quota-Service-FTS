import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { Rules } from '../domain/rules/schemas.js';

// Schema ground rules:
// - The database enforces what it can: positivity, ownership, uniqueness,
//   and the "a rejection consumes nothing" request shape - so a
//   service-layer bug cannot silently corrupt accounting.
// - Monthly usage lives in (owner, month_start) counter rows, so a consume
//   reads its numbers in one place instead of SUM-ing history on every
//   request. No row = zero usage.
//
// NOTE on the accounts <-> plans foreign keys: drizzle resolves reference
// callbacks lazily, and drizzle-kit breaks the cycle by emitting an
// ALTER TABLE for one side - the generated migration is committed, so
// you can see how it was broken (see src/db/migrations).

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  accountPlanId: uuid('account_plan_id')
    .notNull()
    // Mutual FK cycle (accounts <-> plans): the AnyPgColumn annotation cuts
    // TypeScript's circular type inference; drizzle resolves the reference
    // lazily at runtime (docs' circular-references pattern).
    .references((): AnyPgColumn => plans.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // null = predefined, platform-owned, read-only plan (not an account's).
    accountId: uuid('account_id').references((): AnyPgColumn => accounts.id),
    name: text('name').notNull(),
    scope: text('scope').notNull(),
    rules: jsonb('rules').$type<Rules>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT: two predefined plans (account_id null) with the same
    // scope+name collide; per-account custom plans stay unique per owner.
    // (0.45.4 exposes nullsNotDistinct on unique() constraints, not uniqueIndex.)
    unique('plans_owner_scope_name_key').on(t.accountId, t.scope, t.name).nullsNotDistinct(),
    check('plans_scope_ck', sql`${t.scope} in ('account', 'user')`),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    // sha-256 hex of the full `um_...` key; the unique index below makes
    // auth one indexed lookup on the only thing we store.
    keyHash: text('key_hash').notNull(),
    // Display prefix (first 12 chars) so logs/UI can hint at a key without
    // storing anything reusable.
    keyPrefix: text('key_prefix').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_keys_key_hash_key').on(t.keyHash)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    // The calling application's own identifier for its user (email, internal
    // id, anything) - unique within the account, namespaced per account.
    externalId: text('external_id').notNull(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_account_external_key').on(t.accountId, t.externalId)],
);

export const accountUsage = pgTable(
  'account_usage',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    // First day of the UTC calendar month the usage belongs to ('YYYY-MM-DD').
    monthStart: date('month_start', { mode: 'string' }).notNull(),
    // bigint because units are unbounded sums; drizzle's number mode
    // converts in one place (pg returns bigint as text).
    usedUnits: bigint('used_units', { mode: 'number' }).notNull().default(0),
    // Accepted requests this month, maintained by the same locked update as
    // used_units. Without it, monthly_request_cap would have to COUNT(*) the
    // month's accepted ledger rows on every consume - a scan that grows with
    // the month (measured 18.6 ms at 124k rows) and would collapse the
    // per-account rate for cap-configured tenants.
    acceptedRequests: bigint('accepted_requests', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.monthStart] }),
    check('account_usage_nonnegative_ck', sql`${t.usedUnits} >= 0`),
    check('account_usage_requests_nonnegative_ck', sql`${t.acceptedRequests} >= 0`),
  ],
);

export const userUsage = pgTable(
  'user_usage',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    monthStart: date('month_start', { mode: 'string' }).notNull(),
    usedUnits: bigint('used_units', { mode: 'number' }).notNull().default(0),
    // Same idea as account_usage.accepted_requests: the cap rule reads a
    // counter instead of scanning the request table on every consume.
    acceptedRequests: bigint('accepted_requests', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.monthStart] }),
    check('user_usage_nonnegative_ck', sql`${t.usedUnits} >= 0`),
    check('user_usage_requests_nonnegative_ck', sql`${t.acceptedRequests} >= 0`),
  ],
);

// The request ledger: history, idempotency store, and audit trail in one
// table. Every consume decision is recorded with the rules it was judged
// under and the response body we returned.
export const requests = pgTable(
  'requests',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // Client-supplied identifier; (account_id, request_id) is the idempotency key.
    requestId: text('request_id').notNull(),
    units: bigint('units', { mode: 'number' }).notNull(),
    monthStart: date('month_start', { mode: 'string' }).notNull(),
    accepted: boolean('accepted').notNull(),
    // 0 when rejected - a rejection consumes nothing; the CHECKs below
    // keep it that way.
    unitsConsumed: bigint('units_consumed', { mode: 'number' }).notNull(),
    rejectionLevel: text('rejection_level'),
    rejectionRule: text('rejection_rule'),
    // Which plans judged this request + snapshots of their rules, so history
    // stays explainable after plan edits and reassignments.
    accountPlanId: uuid('account_plan_id')
      .notNull()
      .references(() => plans.id),
    userPlanId: uuid('user_plan_id')
      .notNull()
      .references(() => plans.id),
    accountRules: jsonb('account_rules').$type<Rules>().notNull(),
    userRules: jsonb('user_rules').$type<Rules>().notNull(),
    // The response body returned to the caller - the replay source.
    response: jsonb('response').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('requests_account_request_key').on(t.accountId, t.requestId),
    // History pages: keyset pagination on (created_at desc, id desc) per account
    // and per user - stable sort even under concurrent inserts.
    index('requests_account_recent_idx').on(t.accountId, t.createdAt.desc(), t.id.desc()),
    index('requests_user_recent_idx').on(t.userId, t.createdAt.desc(), t.id.desc()),
    check('requests_units_positive_ck', sql`${t.units} > 0`),
    check('requests_consumed_nonnegative_ck', sql`${t.unitsConsumed} >= 0`),
    // A row is either a clean acceptance or a fully-formed rejection -
    // never anything in between.
    check(
      'requests_rejection_shape_ck',
      sql`${t.accepted} or (${t.rejectionLevel} is not null and ${t.rejectionRule} is not null and ${t.unitsConsumed} = 0)`,
    ),
    check(
      'requests_accepted_shape_ck',
      sql`not ${t.accepted} or (${t.unitsConsumed} = ${t.units} and ${t.rejectionLevel} is null and ${t.rejectionRule} is null)`,
    ),
  ],
);
