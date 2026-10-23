# Usage Quota Service

A service that meters usage and enforces quotas for other applications,
where an account's users share one monthly allowance of units and each
user has an individual one.

Uses TypeScript, Express, and PostgreSQL, hosted on Docker. `docker
compose up --build` starts the database, the api on http://localhost:3000,
and the demo client on http://localhost:3001. Migrations and the
predefined plans are applied at startup.

## Contents

- [Setup and demo](#setup-and-demo)
- [Details](#details)
- [Authentication](#authentication)
- [API](#api)
- [Plans and rules](#plans-and-rules)
- [Configuration](#configuration)
- [Performance](#performance)
- [Architecture](#architecture)
- [Tests](#tests)
- [Assumptions](#assumptions)
- [Limitations](#limitations)

## Setup and demo

```bash
docker compose up --build
```

The demo client on http://localhost:3001 walks through the interesting
cases: two users on different plans, a user over their per-request limit,
an account out of its shared allowance, and a plan switch that changes
what a user can do with no client change.

![The demo client after “Run all”](assets/demo.png)

The same scenarios run in the terminal with `npm run demo:headless`,
which exits non-zero if any expectation fails.

Without Docker, run `npm ci && npm run migrate && npm run seed && npm run
dev` against any PostgreSQL 17, with `DATABASE_URL` set in `.env` (see
`.env.example`).

## Details

An **account** is one application, created with a name and identified from
then on by its API key. A **user** is one of that app's end users, known by
the app's own `external_id`. A **plan** is a set of limits that applies
either to an account or to a single user.

```
DocuFlow (account, Starter: 10,000 units/month, 100/request)
├─ alice (Basic: 1,000/month, 20/request)
└─ bob   (Premium: 10,000/month, 100/request)
```

Every consume is checked against the user's plan and the account's plan,
and both must allow it. A request for 25 units by bob is rejected by his
plan (25 is over the 20-per-request cap), even though both monthly
allowances have room. A request for 10 units by bob is accepted while the
account still has 10 or more left, and it adds 10 to bob's usage and 10
to the account's shared usage. The account's usage is the sum of what its
users consumed. Users can share a plan definition, but the counting is
per user: sharing a plan does not share an allowance.

Usage is counted per UTC month. A new month starts at zero on both levels,
and earlier months stay queryable.

## Authentication

Every endpoint except `POST /v1/accounts` needs the account's API key:

```
Authorization: Bearer um_KQogkKCdLF3nb_YzdazD3fpEoRrRnidN3q5Mj2HJ_PI
```

The key is shown once, when the account is created. Only its SHA-256 hash
is stored, and there is no way to get it back or replace it — a lost key
means creating a new account. A fast hash is fine here because the key is
unguessable random data, not a password.

The account is always the one that owns the key, never something taken
from the request. A user or plan belonging to a different account gets the
same 404 as something that doesn't exist, so the api never confirms what
else is out there.

## API

Base URL `http://localhost:3000/v1`.

**Create an account** (the only call without a key):

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
request). Names are labels; the same name twice creates two separate
accounts with their own keys and usage.

**Create a user** (defaults to the **Basic** user plan: 1,000 units/month, 20 per request):

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

**Consume 5 units:**

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

A rejection is still HTTP 200, with `accepted: false`. Reaching the api and
being turned down by a quota rule is a successful call — the refusal is the
answer, not an error — which is also what lets a rejection replay like any
other request. Transport and validation problems are actual errors and do
return 4xx:

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

A rejection charges nothing: `units_consumed` is 0 and neither counter
moves. When more than one rule refuses a request, `reason` holds the first
one in a fixed order (per-request before monthly, user before account) and
`all_reasons` holds them all. The `evaluated` block shows the exact rule
values the decision was made with.

**Retries.** Resend the same `request_id` with the same user and units —
after a timeout, a crash, whatever — and the stored response comes back,
charged once no matter how many times it arrives. The same `request_id`
with a different payload is a conflict:

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "request_id \"order-45\" was already used with a different payload"
  }
}
```

`request_id` is scoped per account, so two accounts can use the same one.
The replayed body is the stored JSON, so its key order can differ from the
first response; compare fields, not bytes.

**Usage** — both levels, any month:

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

If an allowance is cut below what's already used, `remaining` reads 0 —
never negative — and consumption at that level stops until the month turns
over.

**History** — newest first, cursor-paginated:

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

Pass `next_cursor` back as `?cursor=` for the next page. Filters: `?user_id=`,
`?month=`, `?outcome=accepted|rejected`. The cursor is a position in
(`created_at`, `id`) order, so paging stays correct while new rows arrive.

**Reading what's applied:** `GET /v1/account` and `GET /v1/users/:id` return
the object with its plan and current limits; `GET /v1/users` lists users.

Two health endpoints answer outside `/v1`: `GET /healthz` (process up)
and `GET /readyz` (database reachable).

## Plans and rules

Four predefined plans come with the service, seeded on first boot with
fixed ids:

| Plan                   | Scope   | `monthly_allowance` | `max_per_request` | Typical use            |
| ---------------------- | ------- | ------------------- | ----------------- | ---------------------- |
| Starter (`11111111-…`) | account | 10,000 units/month  | 100 units         | default account plan   |
| Pro (`22222222-…`)     | account | 100,000 units/month | 1,000 units       | upgrade target         |
| Basic (`33333333-…`)   | user    | 1,000 units/month   | 20 units          | default user plan      |
| Premium (`44444444-…`) | user    | 10,000 units/month  | 100 units         | higher-limit user plan |

**Custom plans** sit alongside them: `POST /v1/plans` with `name`, `scope`
(`account` or `user`), and `rules`; `GET /v1/plans` lists the predefined
plans plus the account's own; `PATCH /v1/plans/:id` edits a custom plan in
place, while predefined plans answer `403 PLAN_IMMUTABLE`. Assign a plan
with `PATCH /v1/account` or `PATCH /v1/users/:id`. Names are unique per
account and per `scope`; a custom plan may reuse a predefined plan's name
because ids distinguish them.

The rules:

| Rule                  | Meaning                                               | Denies when                    |
| --------------------- | ----------------------------------------------------- | ------------------------------ |
| `monthly_allowance`   | units per UTC month at this level                     | `used + requested > allowance` |
| `max_per_request`     | units in any single request                           | `requested > cap`              |
| `monthly_request_cap` | accepted requests per UTC month, independent of units | `accepted count already ≥ cap` |

`monthly_allowance` and `max_per_request` are the two the product calls
for. `monthly_request_cap` is a third, built the same way as the other
two, and is there to show what adding a rule looks like: a file in
`src/domain/rules/`, one line to register it, and the evaluation code
doesn't change. A plan can combine any of these. A rule a plan doesn't set
doesn't restrict anything, and a plan must set at least one — a plan that
limits nothing is almost always a mistake; set a high allowance instead.

A rejection charges 0 units, and a CHECK constraint on the requests table
keeps it that way.

### Changing plans

A change applies to requests that arrive after it. Usage already counted
stays counted; switching plans never refills the month. A downgrade below
current usage leaves `remaining` at 0 and rejects consumption at that
level until the month turns over; an upgrade reopens the difference
immediately.

History is untouched by plan edits. Each stored request keeps the rule
values it was judged with, so a decision from last month still explains
itself. A change landing in the middle of running requests is fine too:
each request reads the plans once, inside its transaction, and is judged by
exactly those values.

## Configuration

Nothing needs configuring to run the default setup. These variables exist
for host installs and tuning:

| Variable          | Default                                        | Meaning                                                                                          |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`    | `postgres://postgres:postgres@db:5432/fts`     | Postgres connection string (host install: point it at your database)                              |
| `PORT`            | `3000`                                         | API listen port                                                                                   |
| `LOG_LEVEL`       | `info`                                         | `debug` adds per-request logs                                                                    |
| `POOL_MAX`        | `10` (pg's default)                            | Postgres connections per api process. Becomes relevant on hosts with several times this machine's CPU — see Performance |
| `CLIENT_PORT`     | `3001`                                         | Demo client port                                                                                  |
| `USAGE_API_URL`   | `http://localhost:3000/v1`                     | Where the demo client finds the API                                                              |

Inside Docker, set them on the service (`docker compose up -d api` picks up
the environment); on a host install, put them in `.env` (see
`.env.example`).

The compose file caps the api and the db at 2 CPUs each. On stronger
hardware, raise those limits, and once the database becomes the busy side,
raise `POOL_MAX` as well.

Plan limits are data, not configuration. The predefined plans are seeded
rows with fixed ids; tenants make their own through the API. To change what
the predefined ones offer, edit `src/db/predefined.ts` and restart — the
seed upserts by id, and existing assignments keep working since plans are
referenced by id.

## Performance

Measured with k6 against the compose stack on a 4-core laptop, api and db
capped at 2 CPUs each. Scripts, raw output, and reproduction commands:
[performance/README.md](performance/README.md).

**One account tops out around 174 consumes/s.** Every consume locks the
account's counter row for the whole transaction (~5.7 ms), so requests for
the same account run one at a time; more clients only lengthen the queue.
A real account runs into its plan long before this rate: the largest
predefined plan is 100,000 units a month, about one request every 20
seconds spent evenly.

**Across accounts, one api process serves ~380–490 consumes/s**, and ten
concurrent clients are enough to reach that. Beyond it, requests queue
instead of failing: at 1000 clients p95 is 2.8 s with zero errors, and a
fixed arrival rate of 500–1500 req/s is served at ~294/s. What bounds it:
Node runs JavaScript on a single thread, and the database does per-request
work that includes one disk flush per commit. The api holds no state, so
several api processes against the same database should raise the ceiling;
only the single-process setup is tested.

Reads (usage, history) take no locks; in the mixed stage they added ~68
requests/s on top of ~162 consumes/s.

A SQL check recomputes the accounting from the stored requests after every
benchmark stage and compares it to the counters. It passed after all of
them, including the 1000-client and overload runs.

## Architecture

```
src/
  domain/     rules, decision evaluation, month math — pure functions
  services/   consume transaction, plans, users, usage, history (the SQL)
  http/       Express routes, zod validation, auth, error mapping
  db/         drizzle schema, migrations, seed
client/       demo web app
performance/  k6 stages, seed dataset, SQL checker, raw results
tests/        unit + integration
scripts/      persistence probe
```

A consume is one transaction:

1. Load the user with their plan and the account with its plan, and check
   the user belongs to the calling account.
2. Lock the account's counter row, then the user's — same order every
   time, so concurrent requests can't deadlock. Either row is created
   here if the month has none yet.
3. Look up the `request_id`; a hit means this is a retry, and the stored
   response is returned.
4. Evaluate the rules against the locked counters. Accepting means the
   full amount fits both plans.
5. Write a request row with the decision, the rule values used, and the
   response body.
6. If accepted, add the units to both counters.
7. Commit.

The account row stays locked from step 2 to commit, which is where the
concurrency guarantees come from: two requests for one account can't both
spend the same units, and the same `request_id` can't be judged twice.
READ COMMITTED with explicit locks was chosen over SERIALIZABLE because the
contention is one row per account — there's no retry loop to write, and
requests behave the same under load as off it.

One table, `requests`, serves as history, the idempotency record, and the
audit trail. A stored row holds the decision, which plans made it, their
rule values at the time, and the response body that went out.

## Tests

```bash
docker compose --profile test up -d --wait   # integration db (:5433)

npm test                 # 48 unit tests: rules, decisions, month math, HTTP mapping
npm run test:integration # 54 integration tests against a real Postgres
npm run test:persistence # restarts the api container and replays a request
```

The integration suite covers the two-level consume (accepts and every
rejection class), retries including two clients sending the same
`request_id` at the same moment, account isolation, plan changes (usage
kept, remaining floored at 0, history intact), a plan switch landing in
the middle of a request storm, cursor pagination under concurrent inserts,
and the error envelope. The persistence script restarts the real api
container and checks that a retried request replays instead of charging
again.

Every benchmark stage also runs `npm run bench:invariants`, which recomputes
the accounting from raw SQL for all eight load-test accounts.

## Assumptions

Behavior the description left open:

- Months are UTC only; there are no per-account timezones.
- A month with no usage has no counter rows; absence reads as zero.
- A quota rejection is a 200 with the decision in the body.
- A replay returns the stored response. It is stored as JSON, so key
  order may differ between the first response and a replay.
- `request_id` is scoped per account; two accounts can reuse the same id.
- A request that overlaps a plan change is judged by the rules its
  transaction read.
- Keys are shown once at creation; there is no retrieval or rotation.
- Creating an account needs no credentials (see Limitations).
- Users are identified by the calling app's `external_id`; there are no
  logins, emails, or passwords.
- A custom plan may reuse a predefined plan's name; ids differ.
- A plan must set at least one rule.
- Units and rule values are capped at 1e12.
- The predefined plans' limits are fixed defaults, not configuration.
- Stored requests are kept indefinitely; pruning is an operational
  decision.

## Limitations

- One account's consumes top out around 174/s (see Performance). Raising it
  would mean batching the transaction's statements into one database call
  (measured 1.7×) or splitting the account's counter across rows. Neither
  is done — the transaction reads as eight statements in order, and that
  was worth more than the 2.7 ms it costs
  ([analysis](performance/README.md)).
- Only the single-process setup is tested. More api instances should work,
  since they hold no state and the locking is in the database, but that
  hasn't been run.
- No key rotation or retrieval. A lost key means a new account.
- Stored requests are kept forever — the table doubles as the audit trail.
  Pruning would be an operational decision.
- Months are UTC only.
- Account creation is open. Fine for a demo or an internal tool; gate or
  rate-limit it before putting the service anywhere public.
