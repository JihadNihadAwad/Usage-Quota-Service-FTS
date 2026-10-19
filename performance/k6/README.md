# performance/k6 — load-test stages

Staged k6 scripts, run in order against the compose stack (never the test db):

```
npm run bench:seed               # create/reuse the Loadtest Co 1-8 dataset
npm run bench:smoke              # 01 - correctness under load-test conditions
npm run bench:baseline           # 02 - 2 VUs, steady state
npm run bench:contention-user    # 03 - 25 VUs on ONE user
npm run bench:contention-account  # 04 - 100 VUs, one account, 100 users
npm run bench:mixed               # 05 - ramp 10->50, mixed reads + a plan change
npm run bench:multi-account       # 06 - 100 VUs across TWO accounts
npm run bench:scaling             # 07 - 100 VUs across ALL accounts (pool + CPU ceilings)
npm run bench:invariants          # after EVERY stage: counters must match the ledger
```

Stage 07 accepts two env overrides: `VUS` (default 100) and `RESULT_NAME`
(default `07-account-scaling`), so the same script produced the committed
pool-size comparison — raise the api pool first:

```
POOL_MAX=50 docker compose up -d --wait api
docker compose --profile perf run --rm -e RESULT_NAME=07-account-scaling-pool50 k6 run /perf/k6/07-account-scaling.js
```

Every stage reports p(90)/p(95)/p(99) and exports its full summary to
`../results/` as JSON next to the console capture.

`../results/` holds the raw outputs (summaries + console captures + query
plans) committed as evidence; `../loadtest-state.json` (created by the seed
script, gitignored — it contains live API keys) is the dataset handle the
stages and the invariant checker share.
