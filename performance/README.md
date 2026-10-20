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
Run set of 2026-10-19.

| Stage              | Load                                             | Throughput | avg      | p95      | p99      |
| ------------------ | ------------------------------------------------ | ---------- | -------- | -------- | -------- |
| 01 smoke           | 1 VU, correctness pass                           | —          | —        | —        | —        |
| 02 baseline        | 2 VUs × 30 s, 70/20/10 consume/usage/history mix | 211/s      | 9.3 ms   | 16.1 ms  | 22.8 ms  |
| 03 single-user     | 25 VUs, one user, 30 s                           | 155/s      | 160.5 ms | 219.6 ms | 262.9 ms |
| 04 account         | 100 VUs, 100 users, one account, 45 s            | 140/s      | 705.7 ms | 984.7 ms | 1.44 s   |
| 05 mixed           | ramp 0→10→50→0 over 100 s, 70/15/10/5 read mix   | 191/s peak | 123.9 ms | 318.1 ms | 420.1 ms |
| 06 multi-account   | 100 VUs, two accounts, 30 s                      | 275/s      | 362.0 ms | 470.8 ms | 567.3 ms |
| 07 account scaling | 100 VUs, eight accounts, 30 s                    | 325/s      | 306.3 ms | 435.5 ms | 565.6 ms |

Stage 01 is a correctness pass (accept, reject, replay, history) — 10/10
checks. Stage 05 includes one plan PATCH mid-ramp. Stage 06 splits VUs across
two accounts; stage 07 spreads them across all eight.

After every stage, `npm run bench:invariants` recomputes accounting directly
from SQL for every seeded account:

```
account counter == Σ user counters == Σ accepted ledger units
rejected rows consumed nothing · no counter exceeded its allowance
```

All checks passed after every stage. A stage that corrupted accounting would
fail this check regardless of its latency numbers.

## Analysis

### Capacity under concurrent load

Consumes for different accounts take locks on different counter rows, so
accounts do not contend with each other and aggregate throughput grows with
the number of concurrently active accounts until a shared resource binds.
Measured with concurrent clients spread evenly across accounts:

| Concurrent clients | Accounts | Throughput | Notes                                            |
| ------------------ | -------- | ---------- | ------------------------------------------------ |
| 100                | 2        | 275/s      | each account sustains its full ~140/s rate       |
| 100                | 8        | 325/s      | the api's connection pool is the limit           |
| 100                | 8        | 396/s      | pool raised to 50 (`POOL_MAX`) — no code change  |
| 200                | 8        | 412/s      | plateau; db at ~70% of its 2-CPU quota, api ~55% |

The shared limits, in the order they bind as load grows:

1. The api's Postgres connection pool — at pg's default 10 connections,
   requests queue for a connection before reaching the account locks;
   `POOL_MAX=50` raised throughput 22% and reduced p95 by 16% by
   configuration alone.
2. Host CPU — doubling the clients to 200 added 4% throughput while p95 rose
   74%; `docker stats` sampled mid-run shows the db container hottest
   (~70% busy), api ~55%. The limit is the host machine, not a lock or the
   pool.

Per account the ceiling is far above what stage 07 asks of it: ~8–12M
accepted requests per month at ~7 ms per decision, roughly 100× the largest
predefined plan (Pro: 100,000 units/month).

### Per-account rate

Every consume for one account takes `SELECT … FOR UPDATE` on that account's
counter row, in a fixed account → user lock order, so consumes for one
account serialize at ~140–163 decisions/s on this host (~7 ms per decision).

- Stage 03 (25 clients, one user) yields 155/s; stage 04 (100 clients spread
  over 100 users of one account, only the account row shared) yields 140/s.
  Adding 75 clients and 99 more users did not raise throughput — the
  serialized section sets the rate.
- Little's law matches the measured latency: expected average wait ≈ clients /
  throughput — 25 / 155.1 = 161 ms vs 160.5 ms measured; 100 / 140.4 = 712 ms
  vs 705.7 ms. Within ~1%: the latency is the lock queue, not CPU or I/O.
- Reads (usage, history) do not take the counter lock, so they add capacity
  alongside saturated writes: the mixed stage reaches 191 requests/s total
  (~134 consume/s plus ~57 read/s).
- Under concentrated load — many clients on one user or one account —
  requests queue, nothing fails, and accounting stays exact.

### What dominates a consume

A probe inside the compose network
([results/consume-breakdown.txt](results/consume-breakdown.txt)) measured the
api→db round trip at 0.19–0.28 ms per statement. An accepted consume executes
12 statements, so ~2.5 ms of the ~7 ms serialized section is round-trip
latency before database work; the EXPLAIN captures put statement execution at
~2 ms more. The path is round-trip bound, which is why additional VUs cannot
raise the per-account ceiling (stage 04).

Batching the 12 statements into one or two round trips (PL/pgSQL block or
CTEs) would raise the ceiling toward 500–1000/s. Not done: the explicit
statement sequence in `src/services/consume.ts` is what makes the locking
protocol reviewable statement by statement, and the current ceiling is far
beyond what the plans can spend.

### Query-plan audit

`EXPLAIN (ANALYZE, BUFFERS)` over the hot queries
([before](results/explain-queries-before-fix.txt),
[after](results/explain-queries.txt)) found one bad path: history pagination
seq-scanned the account's ledger and top-N sorted it (17.06 ms, 4,149 buffers
for a 21-row page). The keyset index existed but Postgres reads plain
`ORDER BY … DESC` as `DESC NULLS FIRST`, which does not match the index's
`DESC NULLS LAST`, so the index could not serve the ordering. The fix is one
line in `src/services/history.ts`; after it the page is an index scan at
0.157 ms, 6 buffers (~108×).

## Not optimized

- The serialized consume path — see above; batching traded away for
  inspectability.
- Seq scans on `users` (130 rows) and `account_usage` (15 rows) — correct
  planner choices at these sizes; they flip to index scans as tables grow.
- Sharded counters with async rollup — breaks the single-lock linearizability
  that makes limit decisions and idempotency checks race-free.
- Optimistic concurrency (`UPDATE … WHERE used + units <= allowance`) — turns
  contention into retry storms at the hottest rows and complicates the
  two-level all-or-nothing consume.
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

Absolute numbers on a single laptop (WSL2-backed Docker, api and db capped at
2 CPUs each) are indicative; the relationships between stages are the
significant results.
