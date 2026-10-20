# Benchmark environment

All numbers in this directory were produced on this machine on 2026-10-18
(the original run set: stages 01-05, pre/post history-index fix) and
2026-10-19 (the final run set: all six stages re-run with p99 reporting,
the round-trip probe, and the account-scaling stage with its pool
experiments), with the stack exactly as `docker compose up --build`
builds it (api + db on the compose bridge network, k6 in the `perf`
profile talking to `http://api:3000` over that network).

## Host

| | |
|---|---|
| OS | Windows 11 Pro (Docker Desktop, WSL2 backend) |
| CPU | 11th Gen Intel Core i5-11300H @ 3.10 GHz (4 cores / 8 threads) |
| RAM | 16 GB |
| Docker | 29.8.2, compose v5.5.1 |

## Software versions (pinned)

| | |
|---|---|
| k6 | grafana/k6:1.4.0 (compose `perf` profile) |
| PostgreSQL | 17.11 (`postgres:17-alpine`) |
| api runtime | Node 24 (`node:24-alpine` image) |
| Node on host | 22.13.1 (runs the seed/invariant scripts only) |
| k6 summary text | jslib `k6-summary@0.0.3` |

## Resource limits (docker-compose.yml)

- `db`: 2 CPUs, 1 GB RAM
- `api`: 2 CPUs, 512 MB RAM
- `k6`: no explicit limit (load generator; each stage is single-digit CPU)

## Dataset at the end of the runs

- EIGHT independent load-test accounts ("Loadtest Co" .. "Loadtest Co 8"),
  100 users each, all on per-account custom plans; the user plans enable
  all three rules (so every consume reads the request counters), the
  account plans the two unit rules; the first two predate the scaling
  stage and carry the stage 02-06 history
- accepted requests across the eight loadtest ledgers after the
  2026-10-20 run sets: ~200k on account 1 (the stage 02-04 target),
  ~10k on account 2, ~6k on each of accounts 3-8
- 839 users, 48 accounts in the database overall (loadtest, demo, probe
  accounts; 342,670 ledger rows after the 2026-10-20 run sets)

## Stage parameters

| Stage | VUs | Duration | Notes |
|---|---|---|---|
| 01-smoke | 1 | 1 iteration | correctness: accept, reject, replay, history |
| 02-baseline | 2 | 30 s | 70% consume / 20% usage / 10% history |
| 03-contention-user | 25 | 30 s | all requests for ONE user |
| 04-contention-account | 100 | 45 s | 100 users, one account row |
| 05-mixed | ramp 0→10→50→0 | 100 s | 70/15/10/5 read mix + one plan PATCH at t+50s |
| 06-multi-account | 100 | 30 s | 50 VUs per account, two independent accounts |
| 07-account-scaling | 100 | 30 s | 12-13 VUs per account, EIGHT accounts, api pool at default 10 |
| 07 (pool 50) | 100 | 30 s | same stage, `POOL_MAX=50` on the api container |
| 08-capacity | 10/50/100/250/500/1000 | 30 s each | fixed client count; pool 50 (one point repeated at pool 10) |
| 09-saturation | arrival 500→1000→1500/s | 60 s | fixed arrival rate, preAllocatedVUs 1000, maxVUs 4000 |

The 2026-10-19 set covered stages 01-07 plus pool experiments (results
`07-account-scaling*`); the 2026-10-20 morning set re-ran 01-07 on the
counter-optimized code; the 2026-10-20 afternoon set added the capacity
sweep (`08-capacity-*`), the saturation run, and the cost probes
(`consume-breakdown.txt`, `explain-consume-path.txt`). All committed
captures are from the 2026-10-20 sets.

Every stage was followed by `npm run bench:invariants` (counters == ledger,
for ALL loadtest accounts), and every run passed — including the
1000-client sweep point and the saturation run. Latency numbers on a
laptop under Docker are machine-specific, not absolute; the *relationships*
(per-account ceiling, saturation behavior, cost split) are the
significant results.

## CPU telemetry (docker stats, sampled mid-run of the 400-VU knee probe)

| Container | CPU % (of its 2-CPU quota) | Reads as |
| --------- | -------------------------- | -------- |
| fts-db    | ~125–129%                  | ~62–65% busy |
| fts-api   | ~115–119%                  | ~58–60% busy — the Node process's single JS thread is its ceiling |
| k6        | ~22–25%                    | load generator, single-digit need |

Throughput was flat from 10 clients to 1000 (~360–420/s) while latency
grew linearly: the wall is host CPU split across db and api (and the
api's one JS thread), not any lock or the connection pool.
