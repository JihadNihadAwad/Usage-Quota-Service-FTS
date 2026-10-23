# Benchmarks

Load tests and measurement for the service. Everything runs against the same
images `docker compose up --build` produces — k6 in the compose network, the
real api and postgres containers.

- [`k6/`](k6/README.md) — the nine staged scripts and how to run them
- [`results/`](results/README.md) — raw committed captures: k6 summaries,
  console transcripts, EXPLAIN plans, the cost probes
- [`results/environment.md`](results/environment.md) — host, versions, resource
  limits, dataset, run parameters
- [`seed.ts`](seed.ts) — idempotent dataset seed (eight accounts, 100
  users each, generous plans so stages measure locking, not rejections)
- [`check-invariants.ts`](check-invariants.ts) — SQL accounting check, run
  after every stage (inside the api container, over the compose network)
- `probe-cost.cjs`, `probe-db.sql`, `probe-db-nosync.sql` — cost-isolation
  probes (round trips vs durability vs execution)

## Results

All numbers are from the 2026-10-22 run set: every stage re-run the same
day on the same machine and database state, on the current consume path
(counter rows created on a month's first consume, 8 statements). Latencies
are `http_req_duration`, the full round trip through the compose network.

| Stage              | Load                                             | Throughput | avg      | p95      | p99      |
| ------------------ | ------------------------------------------------ | ---------- | -------- | -------- | -------- |
| 01 smoke           | 1 VU, correctness pass                           | —          | —        | —        | —        |
| 02 baseline        | 2 VUs × 30 s, 70/20/10 consume/usage/history mix | 228/s      | 8.5 ms   | 14.1 ms  | 17.9 ms  |
| 03 single-user     | 25 VUs, one user, 30 s                           | 172/s      | 145.9 ms | 331.6 ms | 415.7 ms |
| 04 account         | 100 VUs, 100 users, one account, 45 s            | 174/s      | 570.9 ms | 688.0 ms | 739.8 ms |
| 05 mixed           | ramp 0→10→50→0 over 100 s, 70/15/10/5 read mix   | 241/s peak | 83.4 ms  | 287.9 ms | 448.3 ms |
| 06 multi-account   | 100 VUs, two accounts, 30 s                      | 311/s      | 311.0 ms | 392.5 ms | 430.1 ms |
| 07 account scaling | 100 VUs, eight accounts, 30 s                    | 465/s      | 211.7 ms | 273.6 ms | 367.0 ms |
| 08 capacity        | fixed client count, VUS 10 → 1000 (see below)    | see below  | —        | —        | —        |
| 09 saturation      | arrival rate 500 → 1000 → 1500/s over 60 s      | 294/s      | 9.4 s    | 15.15 s  | 15.41 s  |

Stage 01 is a correctness pass (accept, reject, replay, history) — 10/10
checks. Stage 05 includes one plan PATCH mid-ramp. Stage 06 splits VUs across
two accounts; stages 07–09 spread them across all eight.

After every stage, `npm run bench:invariants` recomputes accounting directly
from SQL for every seeded account:

```
account counter == Σ user counters == Σ accepted ledger units
accepted-request counters == accepted ledger rows at both levels
rejected rows consumed nothing · no counter exceeded its allowance
```

All checks passed after every stage — including the 1000-client and
saturation runs. A stage that corrupted accounting would fail this check
regardless of its latency numbers.

## Capacity

Stage 08 holds a fixed number of concurrent clients for 30 s and reports
what they got. The clients are spread across all eight accounts, so this
measures what the whole setup can do, not what one account can.

| Concurrent clients | Throughput | p50   | p95   | p99   | Failures |
| ------------------ | --------- | ----- | ----- | ----- | -------- |
| 2 (stage 02)       | 228/s     | 10 ms | 14 ms | 18 ms | 0        |
| 10                 | 492/s     | 20 ms | 34 ms | 40 ms | 0        |
| 50                 | 479/s     | 93 ms | 218 ms| 305 ms| 0        |
| 100 (stage 07)     | 418/s     | 224 ms| 385 ms| 536 ms| 0        |
| 250                | 445/s     | 532 ms| 761 ms| 919 ms| 0        |
| 500                | 372/s     | 1.25 s| 1.99 s| 2.49 s| 0        |
| 1000               | 382/s     | 2.50 s| 2.82 s| 3.22 s| 0        |

Ten clients already get the maximum. From there throughput is flat, and
what grows is the wait: the p50s track clients ÷ throughput almost exactly
(10 clients at 492/s is 20 ms measured, 20 predicted; 1000 at 382/s is
2.50 s measured, 2.62 s predicted), so the expected wait at any client
count follows from one number. Nothing fails anywhere in the table; past
the limit, requests spend longer in line. Stage 02's 228/s at two clients
is the same relation read the other way — two clients at 8.5 ms per
request can do ~235/s, so that number is a latency reading, not a capacity
one.

Stage 09 checks the same thing from the demand side: a fixed 500 → 1000 →
1500 requests/s for a minute, of which the setup served ~294/s. Zero
transport failures, and everything k6 kept in flight got an answer (p95
15.2 s). The remaining 29,452 arrivals were never started, because no
client was free to send them. Running past capacity shows up as latency,
nothing else.

## What limits it

`docker stats` during the high-client runs: api at ~115% of its 2 CPUs,
db at ~125%. One limiter on each side:

- Node runs JavaScript on a single thread, so one api process tops out near
  one core regardless of the quota.
- The database does per-request work it can't skip: ~1.6 ms of execution
  (below) and one WAL flush per commit (~1.7 ms — an accepted charge is
  on disk before its 200 goes out).

Measured across both at saturation: (1.15 + 1.25) cores ÷ 465/s ≈ 5.2 ms
of CPU per decision. An earlier version of this file said 2.4 ms; that
divided a CPU reading from one run by a throughput from another. 5.2 is
same-run.

The connection pool isn't involved: the same 100-client point measured
465/s with pg's default pool of 10 and 418/s with the pool at 50. Ten
connections at ~6 ms per transaction would carry ~1,600/s, well past what
this host's CPU does.

Ways up, in order of expense: more api processes behind a balancer (the
api holds no state, so the row locks still arbitrate everything; only one
process is tested), more db CPU, fewer round trips per transaction (below).

## Per account

The other number that matters. Every consume for one account locks that
account's counter row, so they run one at a time at ~5.7 ms each: **~174/s
per account, no matter how many clients are sending.** Stage 04 pointed
100 clients at one account through 100 different users and got 174/s;
stage 03, with 25 clients on a single user, lands in the same place.

The seeded plans allow 100M units/month so the stages measure this and not
quota refusals. On the plans the service actually offers, real traffic
hits the quota long before this limit: Pro is 100,000 units a month, about
one request every 20 seconds spent evenly, and a Starter account spending
at 174/s would burn its whole month in under a minute.

## Where the ~6 ms goes

The locked part of a consume is ~5.7–6.2 ms on this host. Four probes
(the tools sit next to this file; full output in
[results/consume-breakdown.txt](results/consume-breakdown.txt)):

| Path                                                        | Per transaction |
| ----------------------------------------------------------- | -------------- |
| api → db over the compose bridge, 8 statements (as run)      | 6.18 ms        |
| same statements, ONE round trip (batched)                   | 3.50 ms        |
| db-internal unix socket, no network, statement at a time    | 4.04 ms        |
| db-internal, `synchronous_commit = off` (no commit fsync)   | 2.37 ms        |

```
one consume, single client, ~6 ms:

 |======== round trips: 8 statement crossings of the bridge ========|  2.7 ms
 |===== commit flush =====|                                            1.7 ms
 |==== execution ====|                                                  1.6 ms
```

- 2.7 ms is round trips: eight crossings of the docker bridge at ~0.3 ms
  each, the cost of running the locking as eight separate statements
  instead of one call. Network, not database work.
- 1.7 ms is the commit flush.
- 1.6 ms is execution, all index lookups. The statement-by-statement
  numbers are in
  [results/explain-consume-path.txt](results/explain-consume-path.txt);
  the ledger insert is the most expensive at ~0.4 ms warm, maintaining
  six indexes and firing four foreign key checks.

Batching the eight statements into one round trip measures ~286/s per
account, a 1.7× gain, and is not done. Eight statements that read in
order was worth more than the 2.7 ms.

## Costs that were removed

All three found by profiling, all in the consume path:

- The request-cap rule used to COUNT(*) the month's accepted rows inside
  the transaction: 18.6 ms at 124,646 rows, growing as the month fills
  ([before capture](results/explain-request-count-before.txt)). The counts
  now live on the usage rows, maintained by the same update that charges
  the units (migration `0001`), and the stage checker cross-checks them
  against the request rows.
- History pages read the account's whole ledger to return a 21-row page
  (17.06 ms, 4,149 buffers). The query's plain `DESC` means `NULLS FIRST`
  to Postgres while the keyset index is `DESC NULLS LAST`: a different
  sort, so the index couldn't serve it. One line in
  `src/services/history.ts` aligned them; the page is an index scan at
  0.15 ms ([before](results/explain-queries-before-fix.txt),
  [after](results/explain-queries.txt)).
- Until 2026-10-22, every consume also ran two `INSERT ... ON CONFLICT DO
  NOTHING` statements to make sure the month's counter rows existed,
  though they only need creating once a month. The transaction now locks
  first and creates only on miss: 8 statements instead of 10. The two
  partial indexes that fed the old COUNT went with them, cutting the
  ledger insert from eight to six index updates. Stage 04 rose 167 →
  174/s, stage 07 rose 417 → 465/s.

## Not done on purpose

- Batching the consume statements (1.7× per account, above).
- Splitting an account's counter across rows with an async rollup. Buys
  throughput at the cost of the exact per-request accounting the decisions
  and the replay check rely on.
- Optimistic locking (`UPDATE ... WHERE used + units <= allowance`).
  Turns contention into retry loops exactly at the hottest row, and fits
  badly with a two-level all-or-nothing decision.
- Seq scans on small tables; the planner flips these to index scans as
  tables grow.
- Deciding asynchronously. The caller needs the answer before doing the
  metered work; a quota decision can't be a background job.

## Reproduce

See [k6/README.md](k6/README.md) for the full command list. Minimum:

```bash
docker compose up -d --wait
npm run bench:seed
npm run bench:baseline
npm run bench:invariants
```

The client-count sweep and the overload run:

```bash
VUS=10   npm run bench:capacity    # ... up to VUS=1000
npm run bench:saturation           # fixed arrival 500→1500/s
```

Absolute numbers from one laptop (Docker on WSL2, api and db capped at 2
CPUs each) move with the machine. What carries over: the per-account rate,
the queueing-past-capacity behavior, and the cost split.

