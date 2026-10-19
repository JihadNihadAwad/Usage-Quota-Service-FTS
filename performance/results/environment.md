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
  100 users each, all on per-account custom plans with all three rules
  enabled (so every consume runs the request-cap count); the first two
  predate the scaling stage and carry the stage 02-06 history
- 138,261 accepted requests across the eight loadtest ledgers after the
  2026-10-19 run set (93,042 + 10,117 + 35,102 for accounts 3-8;
  138,368 rows total in `requests`, including demo/probe accounts)
- 839 users, 35 accounts in the database overall

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
| 07 (pool 50, 200 VUs) | 200 | 30 s | saturation probe: does more load buy more throughput? |

Every stage was followed by `npm run bench:invariants` (counters == ledger,
for ALL loadtest accounts), and every run passed. Latency numbers on a
laptop under Docker are indicative, not absolute; the *relationships*
between stages are the significant results.

## CPU telemetry (docker stats, sampled twice mid-run of the 200-VU probe)

| Container | CPU % (of its 2-CPU quota) | Reads as |
| --------- | -------------------------- | -------- |
| fts-db    | ~140% / ~138%              | ~70% busy - the hottest container |
| fts-api   | ~110% / ~109%              | ~55% busy |
| k6        | ~27% / ~21%                | load generator, single-digit need |

At this point throughput had plateaued (412/s at 100 VUs vs 396/s at
200 VUs): the wall is host CPU split across db and api, not any lock.
