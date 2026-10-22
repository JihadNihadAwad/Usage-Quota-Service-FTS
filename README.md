# Usage Quota Service

A usage metering and quota service: applications report usage for their end
users against monthly limits defined by plans, and every quota decision is
recorded in a per-account ledger that also serves idempotent retries and
history queries.

```
docker compose up --build
```

The compose file starts three services: PostgreSQL, the API (port 3000),
and a demo web client (port 3001). On startup the API applies its schema
migrations and seeds the predefined plans. The demo client exercises the API
with the same requests documented in the HTTP API section.

## Contents

- [Overview](#overview) — the model: accounts, users, plans, consume
- [Quickstart](#quickstart)
- [Performance](#performance) — measured throughput, latency, and limits
- [Authentication](#authentication)
- [Configuration](#configuration) — environment variables and resource limits
- [HTTP API](#http-api) — bootstrap, consume, quota rejections, replays, usage, history
- [Plans](#plans) — the predefined table, custom plans, rule semantics
- [Design notes](#design-notes)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Assumptions](#assumptions)
- [Known limitations](#known-limitations)

## Overview

- An **account** is a tenant, created through an unauthenticated bootstrap
  endpoint that returns an API key.
- A **user** is one of the account's end users, identified by the calling
  application's own `external_id`.
- A **plan** is a named set of usage rules at one scope: account plans limit
  the tenant as a whole, user plans limit each end user. A consume must pass
  both the account's plan and the user's plan.
- A **consume** records usage. It is all-or-nothing, evaluated in one
  transaction, and every decision — accepted or rejected — is written to the
  account's ledger with the rules it was evaluated under.

## Quickstart

```bash
docker compose up --build      # db + api (:3000) + demo client (:3001)
```

Health endpoints: `GET /healthz` (process up), `GET /readyz` (db reachable).

Without Docker: `npm ci && npm run migrate && npm run seed && npm run dev`
against any PostgreSQL 17 (`DATABASE_URL` in `.env`; see `.env.example`).

## Performance

Measured on the development machine used for the committed benchmark runs
(4-core laptop, Docker Desktop, api and db each capped at 2 CPUs; raw
captures and analysis in [performance/README.md](performance/README.md)):

| Load                                              | Measured result                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 10 concurrent clients, eight accounts             | 492 decisions/s — the ceiling of this deployment is reached with ten clients                            |
| 1000 concurrent clients, eight accounts          | 382 decisions/s, p95 2.8 s — flat from 10 to 1000 clients; zero failures, pure queueing past the ceiling |
| Fixed arrival 500 → 1500 req/s                    | ~294/s served; the rest queues (no errors) — operating past capacity is latency, not failure            |
| 100 concurrent clients, one account (100 users)   | 174 decisions/s — the per-account rate: one account's consumes serialize on its counter row (~5.7 ms)   |
| Reads (usage, history)                            | no counter lock: in the mixed stage they add ~68 requests/s on top of ~162 consume/s                   |

Reading the numbers: two different axes bound this service. Per **account**,
consumes serialize on the account's counter row at ~174 decisions/s —
irrelevant in practice, since the largest plan (Pro) sustains 0.04
requests/s; the ceiling is ~150× what any plan can spend. In **aggregate**,
throughput scales with concurrency until host CPU saturates — ~380–490
decisions/s on this laptop with a single api process (Node runs its JS on
one thread; more capacity means more api processes, and correctness
already lives in Postgres row locks, not in the api). Below saturation,
throughput ≈ concurrent clients ÷ latency; at saturation, wait ≈ concurrent
clients ÷ throughput. Past saturation nothing fails — requests queue and
accounting stays exact, verified by a SQL invariant check after every
benchmark stage.

After every benchmark stage a SQL check recomputes the accounting per
account (`account counter == Σ user counters == Σ accepted ledger units`;
the maintained request counters are checked against the ledger too); all
stages passed it. Capacity curves, the overload run, cost breakdown
(round trips vs durability vs execution), and reproduction commands:
[performance/README.md](performance/README.md).

## Configuration

Everything runs with defaults; these are the knobs that exist. Inside
Docker, set them on the service (`docker compose up -d api` picks them up
from the environment); on a host install, put them in `.env` (see
`.env.example`).

| Variable          | Default                                        | Meaning                                                                                          |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`    | `postgres://postgres:postgres@db:5432/fts`     | Postgres connection string (host install: point it at your database)                              |
| `PORT`            | `3000`                                         | API listen port                                                                                   |
| `LOG_LEVEL`       | `info`                                         | `debug` adds per-request logs                                                                    |
| `POOL_MAX`        | `10` (pg's default)                            | Postgres connections per api process. Only binds once the host has several times this machine's CPU — see the performance section |
| `CLIENT_PORT`     | `3001`                                         | Demo client port                                                                                  |
| `USAGE_API_URL`   | `http://localhost:3000/v1`                     | Where the demo client finds the API                                                              |

The compose file also pins resource limits (api and db at 2 CPUs each) and
uses healthchecks to order startup — the values to change when tuning
throughput on stronger hardware are `POOL_MAX` (until host CPU binds) and
those CPU limits.

Plan values themselves are data, not configuration: the predefined plans
are seeded rows (fixed ids), and tenants create their own plans through the
API. Changing a predefined plan's limits means editing
`src/db/predefined.ts` and restarting — the seed upserts by id, so the
change applies to every fresh database (existing assignment keeps working
since plans are referenced by id).

## Authentication

Every endpoint except `POST /v1/accounts` requires the account's API key:

```
Authorization: Bearer um_KQogkKCdLF3nb_YzdazD3fpEoRrRnidN3q5Mj2HJ_PI
```

The key is returned **exactly once**, in the bootstrap response; only its
SHA-256 hash is stored. There is no key retrieval or rotation — losing it
means bootstrapping a new account (documented in [limitations](#known-limitations)).

## HTTP API

Base URL: `http://localhost:3000/v1`.

**1. Bootstrap an account** (the only unauthenticated mutation):

```bash
curl -s -X POST http://localhost:3000/v1/accounts \
  -H 'Content-Type: application/json' -d '{"name":"Readme Example Co"}'
```

```json
{
  "account": {
    "id": "568b0317-4229-447a-b675-ec317dd4e7ce",
    "name": "Readme Example Co",
    "plan": {
      "id": "11111111-1111-4111-8111-111111111111",
      "name": "Starter",
      "scope": "account",
      "rules": { "max_per_request": 100, "monthly_allowance": 10000 },
      "predefined": true,
      "...": "..."
    },
    "created_at": "2026-10-19T16:41:22.332Z",
    "updated_at": "2026-10-19T16:41:22.332Z"
  },
  "api_key": {
    "key": "um_KQogkKCdLF3nb_YzdazD3fpEoRrRnidN3q5Mj2HJ_PI",
    "key_prefix": "um_KQogkKCdL",
    "created_at": "2026-10-19T16:41:22.332Z"
  }
}
```

No plan given, so the account gets **Starter** (10,000 units/month, 100 per
request). Account names are labels, not unique ids — bootstrapping the same
name twice creates two independent accounts.

**2. Create an end user** (defaults to the **Basic** user plan: 1,000 units/month, 20 per request):

```bash
curl -s -X POST http://localhost:3000/v1/users \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"external_id":"alice"}'
```

```json
{
  "id": "accefee7-3130-4945-85aa-3ebf16a62669",
  "external_id": "alice",
  "plan": {
    "id": "33333333-3333-4333-8333-333333333333",
    "name": "Basic",
    "scope": "user",
    "rules": { "max_per_request": 20, "monthly_allowance": 1000 },
    "predefined": true
  },
  "created_at": "2026-10-19T16:41:22.345Z",
  "updated_at": "2026-10-19T16:41:22.345Z"
}
```

**3. Consume 5 units**:

```bash
curl -s -X POST http://localhost:3000/v1/consume \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"user_id":"<alice id>","request_id":"order-42","units":5}'
```

```json
{
  "request_id": "order-42",
  "accepted": true,
  "units": 5,
  "units_consumed": 5,
  "reason": null,
  "all_reasons": null,
  "account": {
    "plan_id": "11111111-1111-4111-8111-111111111111",
    "used_units": 5,
    "remaining": 9995
  },
  "user": { "plan_id": "33333333-3333-4333-8333-333333333333", "used_units": 5, "remaining": 995 },
  "evaluated": {
    "account_rules": { "max_per_request": 100, "monthly_allowance": 10000 },
    "user_rules": { "max_per_request": 20, "monthly_allowance": 1000 }
  }
}
```

**Quota rejections are HTTP 200** with `accepted: false` — a quota decision is
a successful API call, distinct from transport or protocol errors. A rejection
reports every rule that denied the request:

```json
{
  "request_id": "big-ask",
  "accepted": false,
  "units": 500,
  "units_consumed": 0,
  "reason": {
    "level": "user",
    "rule": "max_per_request",
    "message": "requested 500 units; user plan allows at most 20 per request"
  },
  "all_reasons": [
    {
      "level": "user",
      "rule": "max_per_request",
      "message": "requested 500 units; user plan allows at most 20 per request"
    },
    {
      "level": "account",
      "rule": "max_per_request",
      "message": "requested 500 units; account plan allows at most 100 per request"
    }
  ],
  "account": {
    "plan_id": "11111111-1111-4111-8111-111111111111",
    "used_units": 0,
    "remaining": 10000
  },
  "user": { "plan_id": "33333333-3333-4333-8333-333333333333", "used_units": 0, "remaining": 1000 },
  "evaluated": {
    "account_rules": { "max_per_request": 100, "monthly_allowance": 10000 },
    "user_rules": { "max_per_request": 20, "monthly_allowance": 1000 }
  }
}
```

A rejection consumes nothing: `units_consumed` is 0, counters untouched, and
the ledger still records it. When several rules deny a request, `reason`
names the primary denial (stateless denials first, user before account,
per-request before monthly) and `all_reasons` lists them all.

**4. Replays return the stored decision.** Resend the exact same request
(`request_id` + `user_id` + `units`) after a timeout or crash — the stored
decision is returned without re-charging:

- identical payload → the stored response body again, judged once, charged once
- same `request_id`, different payload → `409`:

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "request_id \"order-45\" was already used with a different payload"
  }
}
```

(Replay fidelity is _content_-identical, not byte-identical: the stored body
lives in a JSONB column, which normalizes key order. No client should depend
on key order — [assumption 15](#assumptions).)

**5. Usage and history** — both levels, any month:

```bash
curl -s "http://localhost:3000/v1/usage" -H "Authorization: Bearer $KEY"
curl -s "http://localhost:3000/v1/users/<id>/usage?month=2026-09" -H "Authorization: Bearer $KEY"
curl -s "http://localhost:3000/v1/history?limit=2" -H "Authorization: Bearer $KEY"
```

```json
{
  "month": "2026-10-01",
  "used_units": 9,
  "allowance": 10000,
  "remaining": 9991,
  "plan": {
    "id": "11111111-1111-4111-8111-111111111111",
    "name": "Starter",
    "scope": "account",
    "rules": { "max_per_request": 100, "monthly_allowance": 10000 },
    "predefined": true
  }
}
```

```json
{
  "items": [
    {
      "id": 138377,
      "request_id": "r-4",
      "user_id": "b64cf6ea-…",
      "units": 900,
      "accepted": false,
      "units_consumed": 0,
      "rejection": { "level": "user", "rule": "max_per_request" },
      "month": "2026-10-01",
      "created_at": "2026-10-19T16:13:25.677Z"
    },
    {
      "id": 138376,
      "request_id": "r-3",
      "user_id": "b64cf6ea-…",
      "units": 3,
      "accepted": true,
      "units_consumed": 3,
      "rejection": null,
      "month": "2026-10-01",
      "created_at": "2026-10-19T16:13:25.665Z"
    }
  ],
  "next_cursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTEwLTE5VDE2OjEzOjI1LjY2NWiLCJpZCI6MTM4Mzc2fQ"
}
```

History pages newest-first via a keyset cursor (`next_cursor`; pass it back as
`?cursor=`) — stable under concurrent inserts, unlike OFFSET. Filter with
`?user_id=`, `?month=`, `?outcome=accepted|rejected`.

The demo client runs thirteen scripted scenarios that cover these calls
plus tenant isolation, plan immutability, and scope mismatch errors.

## Plans

Every plan is a named set of rules at one scope. Four are predefined
(platform-owned, read-only, present from first boot with fixed ids for easy
reference):

| Plan                   | Scope   | `monthly_allowance` | `max_per_request` | Typical use            |
| ---------------------- | ------- | ------------------- | ----------------- | ---------------------- |
| Starter (`11111111-…`) | account | 10,000 units/month  | 100 units         | default account plan   |
| Pro (`22222222-…`)     | account | 100,000 units/month | 1,000 units       | upgrade target         |
| Basic (`33333333-…`)   | user    | 1,000 units/month   | 20 units          | default user plan      |
| Premium (`44444444-…`) | user    | 10,000 units/month  | 100 units         | higher-limit user plan |

**Custom plans** — `POST /v1/plans` with `name`, `scope` (`account` or
`user`), and `rules`. Assign with `PATCH /v1/account`, `PATCH /v1/users/:id`,
or `PATCH /v1/plans/:id` (edits a custom plan in place; predefined plans
answer `403 PLAN_IMMUTABLE`). Names are unique per account and scope.

### Rule semantics

| Rule                  | Meaning                                               | Denies when                    |
| --------------------- | ----------------------------------------------------- | ------------------------------ |
| `monthly_allowance`   | units per UTC month at this level                     | `used + requested > allowance` |
| `max_per_request`     | units in any single request                           | `requested > cap`              |
| `monthly_request_cap` | accepted requests per UTC month, independent of units | `accepted count already ≥ cap` |

- `monthly_allowance` and `max_per_request` are the two core rules;
  `monthly_request_cap` is an additional rule implemented the same way.
  The registry is extensible: one file per rule, one registration line,
  one precedence slot — the evaluator does not change.
- An unconfigured rule imposes no constraint; a plan must configure at least
  one rule.
- **Account and user plans stack.** A consume must pass both: the request
  checks the user's plan _and_ the account's plan, each with its own counters.
- **A rejection consumes nothing** — enforced structurally in the schema: the
  rejected branch of the ledger carries a zero, and a database CHECK pins it.
- **Zero floor:** if usage already exceeds a newly reduced allowance,
  `remaining` reads 0 (never negative) and further consumption is rejected at
  that level.

### Plan-change semantics

- Changes apply to **new requests** — usage already consumed is preserved, and
  no switch grants a fresh allowance.
- Downgrades below existing usage zero out `remaining` and reject further
  consumption at that level; upgrades re-open the difference immediately.
- Past history is untouched, and each ledger row keeps a snapshot of the exact
  rules it was evaluated under, so old decisions stay explainable after edits.
- A plan change landing while consumes are in flight is safe: each request is
  evaluated under exactly one rule set (a concurrency test flips plans
  mid-storm and re-derives the guarantee from the ledger).

## Design notes

- **Quota rejections are HTTP 200** with a decision body; a quota denial is a
  successful API call, which also makes replay trivial.
- **Foreign-tenant ids return 404**, indistinguishable from nonexistent
  ones; a 403 would confirm existence.
- **Pessimistic row locks over SERIALIZABLE:** contention is a single hot row
  per account; `SELECT … FOR UPDATE` in a fixed account → user order gives
  deterministic behavior without retry storms.
- **One ledger table** serves as history, idempotency store, and audit
  trail, with per-request rule snapshots and the stored response body.
- **SHA-256-hashed keys:** a fast hash is adequate here because the input is
  unguessable (unlike a password).

## Testing

```bash
docker compose --profile test up -d --wait   # integration db (:5433)

npm test                 # 48 unit tests (domain, rules, HTTP mapping — no db)
npm run test:integration # 53 integration tests against real Postgres
npm run test:persistence # data survives an api container restart
```

Integration covers the critical behaviors: the all-or-nothing two-level
consume, idempotency (including concurrent first-submissions of the same
`request_id`), tenant isolation, plan changes (preserving usage, zero floor,
history intact), a plan flip landing mid-consume-storm, keyset pagination
stability under concurrent inserts, and the error envelope. The persistence
probe restarts the real api container and verifies a retried request replays
instead of double-charging.

Every benchmark stage additionally runs `npm run bench:invariants`, which
recomputes accounting from raw SQL for all eight load-test accounts.

## Project layout

```
src/
  domain/          rules (one file each), decision evaluation, month math — pure
  services/        consume transaction, plans, users, usage, history — SQL lives here
  http/            Express routes, zod DTOs, auth, errors, serialization
  db/              drizzle schema, migrations, predefined plans
client/            demo web app (server + scripted scenarios)
performance/       k6 stages, seed dataset, SQL invariant checker, raw results
tests/             unit (no db) + integration (real Postgres) suites
scripts/           persistence probe
```

## Assumptions

Where the interface leaves behavior unspecified, this is the chosen behavior
and the reasoning:

1. **`Authorization: Bearer <key>`** — the conventional, explicit header form.
2. **Quota rejections are HTTP 200** with a decision body — the decision is
   the payload of a successful call.
3. **Foreign-tenant resources → 404**, identical to nonexistent ones.
4. **Idempotency is per account** — `(account_id, request_id)` is the key; two
   accounts may reuse the same id.
5. **`request_id`s are retained without expiry** — no pruning semantics;
   retention would be an operational decision.
6. **Usage rows are lazy** — absent row = zero usage for that month.
7. **Months are UTC** — window math stays pure.
8. **Bootstrap is unauthenticated** — the only unauthenticated endpoint, and
   the only unauthenticated mutation.
9. **Predefined plan limits are product choices** — the values in the table
   above.
10. **Keys are shown exactly once** — no retrieval, no rotation.
11. **Users are app users, not logins** — no email/password anywhere.
12. **Custom plans may share names with predefined ones** — separate
    namespaces (owner `NULL` vs account id); ids disambiguate.
13. **A plan must configure at least one rule** — a plan that limits nothing
    is almost certainly a configuration error; set a high allowance instead.
14. **Units per request cap at 1e12** — same bound as rule values; larger
    requests are validation errors.
15. **Replays are content-identical, not byte-identical** — JSONB normalizes
    key order; don't depend on key order.
16. **A consume that overlaps a plan change is evaluated under exactly one
    rule set** — whichever was in effect when the transaction read the plans.

## Known limitations

- **Per-account throughput ceiling** — ~174 decisions/s for a single
  account (its consumes serialize on its counter row, ~150× the largest
  predefined plan's sustainable rate). Aggregate capacity is bounded by
  host CPU and the single api process (one Node thread for JS); measured
  headroom is two orders of magnitude beyond what any plan can spend.
  Raising the per-account rate further would mean batching the consume's
  statements (measured 1.7×) or sharding counters, both declined for
  inspectability ([analysis](performance/README.md)).
- **Single instance** — correctness leans on database row locks, so a second
  api process would work but the design has not been validated for horizontal
  scale-out.
- **No key rotation or retrieval** — a lost key means a new account.
- **`request_id` retention is forever** — ledger grows unbounded by design
  (audit trail); pruning would be an operational decision.
- **UTC only** — no per-tenant timezones.
- **Bootstrap is unauthenticated** — accepted for first-run ergonomics;
  rate-limiting it is a standard production hardening step.
