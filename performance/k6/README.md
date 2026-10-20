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
npm run bench:scaling             # 07 - 100 VUs across ALL accounts
npm run bench:capacity            # 08 - fixed client count, set via VUS (capacity sweep)
npm run bench:saturation          # 09 - fixed arrival rate 500->1500/s (overload behavior)
npm run bench:invariants          # after EVERY stage: counters must match the ledger
```

Stages 07 and 08 accept env overrides: `VUS` (default 100), `DURATION`
(08 only, default 30s), and `RESULT_NAME` (keeps sweep outputs apart), so
one script produces a whole sweep:

```
# the committed capacity sweep (api pool raised first):
POOL_MAX=50 docker compose up -d --wait api
VUS=10    RESULT_NAME=08-capacity-vus10    npm run bench:capacity
VUS=50    RESULT_NAME=08-capacity-vus50   npm run bench:capacity
VUS=250   RESULT_NAME=08-capacity-vus250  npm run bench:capacity
VUS=500   RESULT_NAME=08-capacity-vus500  npm run bench:capacity
VUS=1000  RESULT_NAME=08-capacity-vus1000 npm run bench:capacity
```

Every stage reports p(90)/p(95)/p(99) and exports its full summary to
`../results/` as JSON next to the console capture.

`../results/` holds the raw outputs (summaries + console captures + query
plans) committed as evidence; `../loadtest-state.json` (created by the seed
script, gitignored — it contains live API keys) is the dataset handle the
stages and the invariant checker share.
