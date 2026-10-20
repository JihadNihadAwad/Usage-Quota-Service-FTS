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
  after every stage
- `probe-cost.cjs`, `probe-db.sql`, `probe-db-nosync.sql` — cost-isolation
  probes (round trips vs durability vs execution)

## Results

All latencies are `http_req_duration` (full round trip, compose network).
Run set of 2026-10-20: every stage re-run the same day, same machine, same
database state.

| Stage              | Load                                             | Throughput | avg      | p95      | p99      |
| ------------------ | ------------------------------------------------ | ---------- | -------- | -------- | -------- |
| 01 smoke           | 1 VU, correctness pass                           | —          | —        | —        | —        |
| 02 baseline        | 2 VUs × 30 s, 70/20/10 consume/usage/history mix | 231/s      | 8.4 ms   | 14.7 ms  | 19.1 ms  |
| 03 single-user     | 25 VUs, one user, 30 s                           | 162/s      | 153.7 ms | 207.8 ms | 256.9 ms |
| 04 account         | 100 VUs, 100 users, one account, 45 s            | 167/s      | 593.8 ms | 680.5 ms | 721.3 ms |
| 05 mixed           | ramp 0→10→50→0 over 100 s, 70/15/10/5 read mix   | 220/s peak | 107.4 ms | 240.5 ms | 276.2 ms |
| 06 multi-account   | 100 VUs, two accounts, 30 s                      | 280/s      | 240.7 ms | 297.0 ms | 348.9 ms |
| 07 account scaling | 100 VUs, eight accounts, 30 s                    | 417/s      | 238.4 ms | 287.1 ms | 334.5 ms |
| 08 capacity        | fixed client count, VUS 10 → 1000 (see below)    | see below  | —        | —        | —        |
| 09 saturation      | arrival rate 500 → 1000 → 1500/s over 60 s      | 329/s      | 6.96 s   | 14.25 s  | 14.88 s  |

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
| 2 (stage 02)       | 231/s     | 9 ms  | 15 ms | 19 ms | 0        |
| 10                 | 412/s     | 21 ms | 41 ms | 63 ms | 0        |
| 50                 | 379/s     | 113 ms| 252 ms| 421 ms| 0        |
| 100 (stage 07)     | 358/s     | 263 ms| 391 ms| 531 ms| 0        |
| 250                | 394/s     | 589 ms| 845 ms| 942 ms| 0        |
| 500                | 411/s     | 1.2 s | 1.5 s | 1.7 s | 0        |
| 1000               | 366/s     | 2.7 s | 3.2 s | 3.4 s | 0        |

Two facts fall out of this table, and they are the summary of the whole
performance section:

1. **This deployment saturates at ~360–420 decisions/s** — reached with as
   few as **ten concurrent clients**. Past that, throughput is flat while
   latency grows linearly with client count: pure queueing, zero failures,
   accounting exact. The rule for reading any point is Little's law —
   average wait ≈ concurrent clients ÷ throughput — which the measured
   p50s match almost exactly at every row (10/412 = 24 ms vs 21; 1000/366
   = 2.73 s vs 2.65). For 10,000 concurrent clients the same arithmetic
   predicts ~27 s of queueing; nothing breaks, callers just wait.
2. **Stage 02's 231/s is not a ceiling — it is two clients' worth of
   throughput.** Two sequential clients do 2 ÷ 0.0087 s ≈ 230/s; the
   number is a latency reading (8.4 ms per request), not a capacity one.
   Capacity needs concurrency, and ten clients are enough to reach this
   machine's limit.

### What happens past the knee

Stage 09 drives a fixed arrival rate instead of a fixed client count,
stepping 500 → 1000 → 1500 requests/s over a minute. The deployment
served ~329/s of it. Everything the queue could hold was served —
**zero transport failures, checks 100%** — with in-flight latency climbing
to p95 14.3 s, and once in-flight requests exhausted the 4000-VU pool k6
reported 25,072 `dropped_iterations`: arrivals that could not be started
because nothing had come back yet. That is what operating beyond capacity
looks like from the outside — the deployment answers everything it is
asked, correctly, and the rest waits in a queue whose depth the caller
experiences as latency. There is no failure mode to trip; there is only
the wait.

### What binds at the ceiling, and what would move it

`docker stats` sampled during the 1000-client run: **api ~115%, db ~125%**
of their 2-CPU quotas — i.e. the api process is at ~1.2 cores and the
database at ~1.25, on a 4-core host that also runs the load generator and
the Windows/WSL2 layer. The limit is host CPU, and the api's share of it
is a single Node process — Node executes JavaScript on one thread, so one
api process tops out at ~1 core of JS no matter the quota. The measured
CPU cost per decision is ~2.4 ms across api and db combined
(2.44 cores ÷ 412/s).

- **The connection pool does not bind on the current code.** The same
  250-client point measured 423/s with pg's default pool of 10 and 394/s
  with the pool at 50 — noise. Ten connections × one-transaction-per-
  6.8 ms supports ~1,470/s, far above this host's CPU ceiling. (An
  earlier write-up called the pool "the first shared limit"; that was
  true of the pre-2026-10-20 code, whose in-transaction COUNT scans held
  connections much longer — see below. On the current 10-statement
  transaction, `POOL_MAX` only matters once a host has ~4× this CPU.)
- **More accounts do not add capacity past the knee** — the locks were
  never the binding limit there; CPU is. More hardware does, and so does
  running more api processes: all correctness lives in Postgres row
  locks, so multiple api instances behind a load balancer share the same
  guarantees (the deployment tested here is one api process; multi-
  instance operation is documented as unvalidated in the README's
  limitations).

### Per-account rate — the other axis

Everything above is the *aggregate* axis. The *per-account* axis is set by
the account counter row lock: every consume for one account serializes on
that account's row, at ~6.8 ms per decision — **~165 decisions/s for a
single account, no matter how many clients pile on**. Stage 04 pushed 100
concurrent clients at one account through 100 different users: 167/s, with
the queue visible as p95 680 ms. Stage 03 (25 clients, one user) lands in
the same place.

Is that a problem? The stages are deliberately a stress shape — no real
account generates 100 continuous concurrent calls; a burst is the realistic
version, and bursts queue and drain at the same rate. The loadtest plans
are generous on purpose (100M units/month) so the stages measure the
machinery rather than quota exhaustion. On the plans the service actually
sells, the ceiling is unreachable: Pro allows 100,000 units/month ≈ 0.04
requests/s sustained; a single account's ~165/s ceiling is ~140× that. A
Starter account (10,000 units) hammering at its ceiling would exhaust the
entire month's allowance in about a minute — quota, not speed, is what
stops real traffic.

## Where the ~6.8 ms goes — round trips, durability, execution

The serialized section of a consume is ~6.8 ms on this host. Four probes
(the tools are committed next to this file; full numbers in
[results/consume-breakdown.txt](results/consume-breakdown.txt)) split it:

| Path                                                        | Per transaction |
| ----------------------------------------------------------- | -------------- |
| api → db over the compose bridge, 10 statements (as run)    | 6.83 ms        |
| same statements, ONE round trip (batched)                   | 3.74 ms        |
| db-internal unix socket, no network, statement at a time    | 4.45 ms        |
| db-internal, `synchronous_commit = off` (no commit fsync)   | 2.47 ms        |

- **~3.1 ms (45%) is round trips** — ten crossings of the docker bridge at
  ~0.3 ms each. That is the cost of running the locking protocol as ten
  explicit, inspectable statements rather than one opaque block; it is
  bridge latency, not database work.
- **~2.0 ms is the commit fsync** — the price of durability: an accepted
  charge is on disk the moment the caller gets its 200. Required by the
  service's own contract (data survives restart).
- **~1.5 ms is actual execution**, index-served throughout — see
  [results/explain-consume-path.txt](results/explain-consume-path.txt)
  for the statement-by-statement EXPLAIN ANALYZE: every statement in the
  path is an index scan/PK lookup at 0.08–0.55 ms, and the ledger insert
  (the most expensive, ~0.85 ms warm) maintains eight indexes and fires
  four foreign-key checks.

Batching the ten statements into one round trip is measured to raise the
per-account ceiling to ~267/s (1.6×); an earlier estimate of "500–1000/s"
in this directory predates the measurement and is superseded. It is still
not done — the explicit sequence is the reviewable form of the lock
protocol, and ~165/s is two orders of magnitude beyond any plan the
service sells.

## Costs found and removed

Two real defects were found by measuring rather than arguing, both in the
consume path, both gone:

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

## Not optimized

- Batching the consume statements (measured 1.6× per account) — traded for
  statement-level inspectability of the lock protocol.
- Seq scans on small tables (users at ~800 rows is now an index scan; the
  planner flips these as tables grow).
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

