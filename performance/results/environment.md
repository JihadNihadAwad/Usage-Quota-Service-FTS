# Benchmark environment

All numbers in this directory were produced on this machine on 2026-10-18
(the original run set: stages 01-05, pre/post history-index fix) and
2026-10-19 (the final run set: all six stages re-run with p99 reporting,
plus the round-trip probe), with the stack exactly as
`docker compose up --build` builds it (api + db on the compose bridge
network, k6 in the `perf` profile talking to `http://api:3000` over that
network).

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

- TWO independent load-test accounts ("Loadtest Co", "Loadtest Co 2"), 100
  users each, all on per-account custom plans with all three rules enabled
  (so every consume runs the request-cap count)
- 91,374 accepted requests across the two loadtest ledgers (87,185 + 4,189)
  after the 2026-10-19 run set (91,451 rows total in `requests`, including
  demo/probe accounts)
- 230 users, 22 accounts in the database overall

## Stage parameters

| Stage | VUs | Duration | Notes |
|---|---|---|---|
| 01-smoke | 1 | 1 iteration | correctness: accept, reject, replay, history |
| 02-baseline | 2 | 30 s | 70% consume / 20% usage / 10% history |
| 03-contention-user | 25 | 30 s | all requests for ONE user |
| 04-contention-account | 100 | 45 s | 100 users, one account row |
| 05-mixed | ramp 0→10→50→0 | 100 s | 70/15/10/5 read mix + one plan PATCH at t+50s |
| 06-multi-account | 100 | 30 s | 50 VUs per account, two independent accounts |

Every stage was followed by `npm run bench:invariants` (counters == ledger,
for BOTH loadtest accounts), and every run passed. Latency numbers on a
laptop under Docker are indicative, not absolute; the *relationships*
between stages are the significant results.
