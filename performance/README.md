# Benchmarks

Load tests and measurement for the service. Everything runs against the same
images `docker compose up --build` produces — k6 in the compose network, the
real api and postgres containers.

- [`k6/`](k6/README.md) — the nine staged scripts and how to run them
- [`results/`](results/README.md) — raw committed captures: k6 summaries,
  console transcripts, EXPLAIN plans, the cost probes
- [`results/environment.md`](results/environment.md) — host, versions, resource
  limits, dataset, run parameters
- [`seed.ts`](seed.ts) — idempotent dataset bootstrap (eight accounts, 100
  users each, generous plans so stages measure locking, not rejections)
- [`check-invariants.ts`](check-invariants.ts) — SQL accounting check, run
  after every stage (inside the api container, over the compose network)
- `probe-cost.cjs`, `probe-db.sql`, `probe-db-nosync.sql` — cost-isolation
  probes (round trips vs durability vs execution)

## Results

All latencies are `http_req_duration` (full round trip, compose network).
Run set of 2026-10-22, after the steady-state consume rework (lock-first
counter creation, 8 statements; dead partial indexes dropped): every stage
re-run the same day, same machine, same database state.

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

## The capacity curve

Stage 08 holds a fixed number of concurrent clients for 30 s and reports
what they got. Clients are round-robined across all eight accounts, so
per-account locks never bind; the curve shows what the *deployment*
sustains. (api pool at 50 for all points; the pool-10 comparison below
shows the pool is not what binds.)

| Concurrent clients | Throughput | p50   | p95   | p99   | Failures |
| ------------------ | --------- | ----- | ----- | ----- | -------- |
| 2 (stage 02)       | 228/s     | 10 ms | 14 ms | 18 ms | 0        |
| 10                 | 492/s     | 20 ms | 34 ms | 40 ms | 0        |
| 50                 | 479/s     | 93 ms | 218 ms| 305 ms| 0        |
| 100 (stage 07)     | 418/s     | 224 ms| 385 ms| 536 ms| 0        |
| 250                | 445/s     | 532 ms| 761 ms| 919 ms| 0        |
| 500                | 372/s     | 1.25 s| 1.99 s| 2.49 s| 0        |
| 1000               | 382/s     | 2.50 s| 2.82 s| 3.22 s| 0        |

Two facts fall out of this table, and they are the summary of the whole
performance section:

1. **This deployment saturates at ~380–490 decisions/s** — reached with as
   few as **ten concurrent clients**. Past that, throughput is flat while
   latency grows linearly with client count: pure queueing, zero failures,
   accounting exact. The rule for reading any point is Little's law —
   average wait ≈ concurrent clients ÷ throughput — which the measured
   p50s match closely (10/492 = 20 ms vs 20; 1000/382 = 2.62 s vs 2.50).
   For 10,000 concurrent clients the same arithmetic predicts ~26 s of
   queueing; nothing breaks, callers just wait.
2. **Stage 02's 228/s is not a ceiling — it is two clients' worth of
   throughput.** Two sequential clients do 2 ÷ 0.0085 s ≈ 235/s; the
   number is a latency reading (8.5 ms per request), not a capacity one.
   Capacity needs concurrency, and ten clients are enough to reach this
   machine's limit.

### What happens past the knee

Stage 09 drives a fixed arrival rate instead of a fixed client count,
stepping 500 → 1000 → 1500 requests/s over a minute. The deployment
served ~294/s of it. Everything the queue could hold was served —
**zero transport failures, checks 100%** — with in-flight latency climbing
to p95 15.2 s, and once in-flight requests exhausted the 4000-VU pool k6
reported 29,452 `dropped_iterations`: arrivals that could not be started
because nothing had come back yet. That is what operating beyond capacity
looks like from the outside — the deployment answers everything it is
asked, correctly, and the rest waits in a queue whose depth the caller
experiences as latency. There is no failure mode to trip; there is only
the wait.

### What binds at the ceiling, and what would move it

`docker stats` sampled during the high-client runs: **api ~115%, db ~125%**
of their 2-CPU quotas. Two real constraints, one per side:

- **The api process is a single Node thread.** Node executes JavaScript on
  one core regardless of the quota, so one api process tops out at ~1 core
  of JS plus driver overhead — on this 4-core/8-thread laptop that is
  roughly a quarter of the machine before the database spends anything.
- **The database pays per-decision work it cannot skip:** ~1.7 ms of
  execution per consume (below) and one WAL fsync per commit (~1.6 ms —
  durability; an accepted charge is on disk the moment its 200 goes out).
  At 400/s that is ~0.7 of db CPU before indexes, locking, or the 2.44
  cores Docker reports for it.

Is the ceiling a hardware figure or a software one? The capacity curve
answers it: ten clients reach the same throughput as a thousand, so the
service is not spending its extra clients on anything — it is spending
CPU per decision at a roughly fixed rate. Per-decision cost, measured
across the stack at saturation: (1.15 + 1.25) cores ÷ 465/s ≈ **5.2 ms of
CPU per decision** across api and db combined (the earlier "2.4 ms" figure
in this directory divided by a throughput measured on a *different*
run set; this one is same-run and correct). Scaling this design out is
mechanical and tested up to the parts that exist:

- **More api processes.** All correctness lives in Postgres row locks, so
  N api instances behind a load balancer keep every guarantee; capacity
  grows with N until the db binds. (The single-instance deployment here is
  the tested configuration; multi-instance operation is listed as
  unvalidated in the README's limitations.)
- **More db CPU** helps the fsync+execution share; batching the consume
  statements (below) cuts round trips first.
- **The connection pool does not bind on the current code** — the same
  100-client point measured 465/s with pg's default pool of 10 and 418/s
  with the pool at 50 (noise). Ten connections × one 6 ms transaction
  support ~1,600/s, far above this host's CPU ceiling.

### Per-account rate — the other axis

Everything above is the *aggregate* axis. The *per-account* axis is set by
the account counter row lock: every consume for one account serializes on
that account's row, at ~5.7 ms per decision — **~174 decisions/s for a
single account, no matter how many clients pile on**. Stage 04 pushed 100
concurrent clients at one account through 100 different users: 174/s, with
the queue visible as p95 688 ms. Stage 03 (25 clients, one user) lands in
the same place.

Is that a problem? The stages are deliberately a stress shape — no real
account generates 100 continuous concurrent calls; a burst is the realistic
version, and bursts queue and drain at the same rate. The loadtest plans
are generous on purpose (100M units/month) so the stages measure the
machinery rather than quota exhaustion. On the plans the service actually
sells, the ceiling is unreachable: Pro allows 100,000 units/month ≈ 0.04
requests/s sustained; a single account's ~174/s ceiling is ~150× that. A
Starter account (10,000 units) hammering at its ceiling would exhaust the
entire month's allowance in about a minute — quota, not speed, is what
stops real traffic.

## Where the ~6 ms goes — round trips, durability, execution

The serialized section of a consume is ~5.7–6.2 ms on this host (two
statement fewer than the 2026-10-20 set: the monthly counter rows are now
created under the lock only on a month's first consume). Four probes (the
tools are committed next to this file; full numbers in
[results/consume-breakdown.txt](results/consume-breakdown.txt)) split it:

| Path                                                        | Per transaction |
| ----------------------------------------------------------- | -------------- |
| api → db over the compose bridge, 8 statements (as run)      | 6.18 ms        |
| same statements, ONE round trip (batched)                   | 3.50 ms        |
| db-internal unix socket, no network, statement at a time    | 4.04 ms        |
| db-internal, `synchronous_commit = off` (no commit fsync)   | 2.37 ms        |

- **~2.7 ms (43%) is round trips** — eight crossings of the docker bridge
  at ~0.3 ms each. That is the cost of running the locking protocol as
  explicit, inspectable statements rather than one opaque block; it is
  bridge latency, not database work.
- **~1.7 ms is the commit fsync** — the price of durability: an accepted
  charge is on disk the moment the caller gets its 200. Required by the
  service's own contract (data survives restart).
- **~1.6 ms is actual execution**, index-served throughout — see
  [results/explain-consume-path.txt](results/explain-consume-path.txt)
  for the statement-by-statement EXPLAIN ANALYZE: every statement in the
  path is an index scan/PK lookup at 0.08–0.55 ms, and the ledger insert
  (the most expensive, ~0.85 ms warm) maintains six indexes and fires four
  foreign-key checks.

Batching the eight statements into one round trip is measured to raise the
per-account ceiling to ~286/s (1.7×). It is still not done — the explicit
sequence is the reviewable form of the lock protocol, and ~174/s is two
orders of magnitude beyond any plan the service sells.

## Costs found and removed

Three real costs were found by measuring rather than arguing, all in the
consume path, all gone:

- **The request-cap counts** (until 2026-10-20) were two `COUNT(*)` scans
  over the month's accepted ledger rows, inside the serialized
  transaction. At 124,646 accepted rows the account-level count measured
  **18.6 ms** — a per-account rate that would collapse as the month
  filled for any tenant configuring the cap on an account plan
  ([before capture](results/explain-request-count-before.txt)). The
  counts now live on the usage rows (maintained by the same locked update
  that charges units; migration `0001`), the statements are gone, and the
  invariant checker cross-checks the counters against the ledger.
- **History pagination** seq-scanned and top-N sorted the account's whole
  ledger (17.06 ms, 4,149 buffers for a 21-row page) because the query's
  plain `DESC` means `NULLS FIRST` to Postgres while the keyset index is
  `DESC NULLS LAST` — different sort order, so the index could not serve
  it. One line in `src/services/history.ts`; the page became an index
  scan at 0.15 ms warm
  ([before](results/explain-queries-before-fix.txt),
  [after](results/explain-queries.txt),
  [current path audit](results/explain-consume-path.txt)).
- **Per-request setup statements + dead indexes** (until 2026-10-22):
  every consume paid two `INSERT ... ON CONFLICT DO NOTHING` statements
  to guarantee the month's counter rows existed — but the rows only need
  creating once per account per month. The transaction now locks first
  and creates only on miss, so steady state is 8 statements not 10; and
  the two partial indexes that fed the old COUNT queries (nothing has
  read them since the counters landed) are dropped, cutting every ledger
  insert from eight to six index maintenance operations. Stage 04 rose
  from 167/s to 174/s and stage 07 from 417/s to 465/s on this change.

## Not optimized

- Batching the consume statements (measured 1.7× per account) — traded for
  statement-level inspectability of the lock protocol.
- Seq scans on small tables (the planner flips these to index scans as
  tables grow).
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

The capacity curve and the overload point:

```bash
VUS=10   npm run bench:capacity    # ... up to VUS=1000
npm run bench:saturation           # fixed arrival 500→1500/s
```

Absolute numbers on a single laptop (WSL2-backed Docker, api and db capped
at 2 CPUs each) move with the machine; the relationships — per-account
ceiling, saturation behavior, the cost split — are the transferable
results.

