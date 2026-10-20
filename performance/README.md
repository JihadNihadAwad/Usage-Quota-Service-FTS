# Benchmarks

Load tests and measurement for the service. Everything runs against the same
images `docker compose up --build` produces — k6 in the compose network, the
real api and postgres containers.

- [`k6/`](k6/README.md) — the seven staged scripts and how to run them
- [`results/`](results/README.md) — raw committed captures: k6 summaries,
  console transcripts, EXPLAIN plans, the round-trip probe
- [`results/environment.md`](results/environment.md) — host, versions, resource
  limits, dataset, run parameters
- [`seed.ts`](seed.ts) — idempotent dataset bootstrap (eight accounts, 100
  users each, generous plans so stages measure locking, not rejections)
- [`check-invariants.ts`](check-invariants.ts) — SQL accounting check, run
  after every stage

## Results

All latencies are `http_req_duration` (full round trip, compose network).
Run set of 2026-10-20: every stage re-run the same afternoon, same machine,
same database state.

| Stage              | Load                                             | Throughput | avg      | p95      | p99      |
| ------------------ | ------------------------------------------------ | ---------- | -------- | -------- | -------- |
| 01 smoke           | 1 VU, correctness pass                           | —          | —        | —        | —        |
| 02 baseline        | 2 VUs × 30 s, 70/20/10 consume/usage/history mix | 231/s      | 8.4 ms   | 14.7 ms  | 19.1 ms  |
| 03 single-user     | 25 VUs, one user, 30 s                           | 162/s      | 153.7 ms | 207.8 ms | 256.9 ms |
| 04 account         | 100 VUs, 100 users, one account, 45 s            | 167/s      | 593.8 ms | 680.5 ms | 721.3 ms |
| 05 mixed           | ramp 0→10→50→0 over 100 s, 70/15/10/5 read mix   | 220/s peak | 107.4 ms | 240.5 ms | 276.2 ms |
| 06 multi-account   | 100 VUs, two accounts, 30 s                      | 280/s      | 240.7 ms | 297.0 ms | 348.9 ms |
| 07 account scaling | 100 VUs, eight accounts, 30 s                    | 417/s      | 238.4 ms | 287.1 ms | 334.5 ms |

Stage 01 is a correctness pass (accept, reject, replay, history) — 10/10
checks. Stage 05 includes one plan PATCH mid-ramp. Stage 06 splits VUs across
two accounts; stage 07 spreads them across all eight.

After every stage, `npm run bench:invariants` recomputes accounting directly
from SQL for every seeded account:

```
account counter == Σ user counters == Σ accepted ledger units
accepted-request counters == accepted ledger rows at both levels
rejected rows consumed nothing · no counter exceeded its allowance
```

All checks passed after every stage. A stage that corrupted accounting would
fail this check regardless of its latency numbers.

## How to read the numbers

The service has two distinct performance characteristics, and the stages
separate them.

### 1. Per-account rate — one account tops out at ~165 decisions/s

Every consume for one account takes a row lock on that account's monthly
counter, so consumes for the *same* account serialize. Stage 04 pushed 100
concurrent clients at one account through 100 different users and got
167/s: adding clients changes queue depth (p95 680 ms), not throughput.
Stage 03 (25 clients, one user) lands in the same place — 162/s. Little's
law confirms the latency is the lock queue, not CPU: expected average wait
100 / 167 = 599 ms vs 594 ms measured.

Put against the plans: the largest predefined plan (Pro) allows 100,000
units/month — about 0.04 requests/s sustained. One account's ceiling is
~165/s ≈ 14M decisions/month, roughly 140× Pro's allowance. No plan the
service sells can be spent fast enough to hit it; a tenant only sees the
ceiling by hammering one account with hundreds of concurrent clients, and
then requests queue rather than fail, with accounting exact afterwards.

### 2. Aggregate capacity — scales with active accounts, then saturates

Consumes for *different* accounts take locks on *different* rows, so total
throughput grows with the number of concurrently active accounts until a
shared resource binds:

| Concurrent clients | Accounts | Throughput | What binds                        |
| ------------------ | -------- | ---------- | --------------------------------- |
| 100                | 2        | 280/s      | nothing yet (per-account rate)    |
| 100                | 8        | 417/s      | approaching host CPU              |
| 100                | 8, pool 50 | 358/s    | host CPU (pool no longer limits) |
| 400                | 8, pool 50 | 365/s    | host CPU — the knee              |

The knee on this machine is ~360–420 decisions/s aggregate. Quadrupling the
clients to 400 bought no throughput (365/s, within run noise) while p99
doubled to 2.0 s — pure queueing. `docker stats` sampled mid-run shows both
containers pinned near their 2-CPU quotas (api ~115%, db ~125–129%) on this
4-core laptop: the limit is the host, not a lock or a pool setting. Past
the knee, more accounts add no capacity — more hardware does.

The api's connection pool is a real intermediate limit at pg's default of
10 (`POOL_MAX=50` removes it as a factor at these client counts). Pool-50 at
100 VUs measured 358/s in this set vs 396/s in the 2026-10-19 set —
run-to-run variance on a shared laptop is a few percent; the binding *order*
(per-account lock → pool → host CPU) is the stable result.

Reads (usage, history) do not take the counter lock, so they add capacity
alongside saturated writes: the mixed stage sustains ~220 req/s combined
(~141 consume/s plus ~59 read/s) against a single account.

### What dominates a consume, and what was fixed

A probe inside the compose network
([results/consume-breakdown.txt](results/consume-breakdown.txt)) measured
the api→db round trip at ~0.3 ms per statement. An accepted consume is 10
statements (~3 ms of round-trip latency before any database work), plus
~2 ms of statement execution; the serialized section is ~6 ms per decision.

Two costs in the original path were measured and then removed rather than
argued about:

- **The request-cap counts** used to be two `COUNT(*)` queries over the
  month's accepted ledger rows, inside the serialized transaction. At
  124,646 accepted rows the account-level count measured **18.6 ms**
  ([results/explain-request-count-before.txt](results/explain-request-count-before.txt))
  — a per-account rate that would degrade as the month filled. The counts
  now live on the usage counter rows (incremented by the same locked update
  that charges units; migration `0001`), the two statements are gone from
  the transaction, and the invariant checker cross-checks the counters
  against the ledger after every stage.
- **History pagination** seq-scanned and top-N sorted the account's whole
  ledger (17.06 ms, 4,149 buffers for a 21-row page) because the query's
  plain `DESC` means `NULLS FIRST` to Postgres while the keyset index is
  `DESC NULLS LAST` — a different sort order, so the index could not serve
  it. One line in `src/services/history.ts`; the page became an index scan
  at 0.157 ms, 6 buffers (~108×). Captures:
  [before](results/explain-queries-before-fix.txt),
  [after](results/explain-queries.txt).

What remains is round-trip bound, by design. Batching the 10 statements
into one or two round trips (a PL/pgSQL block or CTEs) would raise the
per-account ceiling toward 500–1000/s; not done, because the explicit
statement sequence in `src/services/consume.ts` is what makes the locking
protocol reviewable statement by statement, and the current ceiling is two
orders of magnitude beyond what any predefined plan can spend.

## Not optimized

- Seq scans on `users` (130 rows) and `account_usage` (15 rows) — correct
  planner choices at these sizes; they flip to index scans as tables grow.
- Sharded counters with async rollup — breaks the single-lock
  linearizability that makes limit decisions and idempotency checks
  race-free.
- Optimistic concurrency (`UPDATE … WHERE used + units <= allowance`) —
  turns contention into retry storms at the hottest rows and complicates
  the two-level all-or-nothing consume.
- Queueing decisions asynchronously — a quota decision must be synchronous;
  the caller needs the answer before doing the metered work.

## Reproduce

See [k6/README.md](k6/README.md) for the full command list. Minimum:

```bash
docker compose up -d --wait
npm run bench:seed
npm run bench:baseline
npm run bench:invariants
```

The pool and knee experiments:

```bash
POOL_MAX=50 docker compose up -d api   # pool no longer limits; re-run bench:scaling
VUS=400 npm run bench:scaling          # push past the knee: throughput flat, latency up
```

Absolute numbers on a single laptop (WSL2-backed Docker, api and db capped
at 2 CPUs each) move with the machine; the relationships between stages are
the significant results.

