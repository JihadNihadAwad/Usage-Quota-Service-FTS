# performance/k6 — load-test stages

Staged k6 scripts, run in order against the compose stack (never the test db):

```
npm run bench:seed               # create/reuse the Loadtest Co dataset
npm run bench:smoke              # 01 - correctness under load-test conditions
npm run bench:baseline           # 02 - 2 VUs, steady state
npm run bench:contention-user    # 03 - 25 VUs on ONE user
npm run bench:contention-account # 04 - 100 VUs, one account, 100 users
npm run bench:mixed              # 05 - ramp 10->50, mixed reads + a plan change
npm run bench:invariants         # after EVERY stage: counters must match the ledger
```

`../results/` holds the raw outputs (summaries + console captures + query
plans) committed as evidence; `../loadtest-state.json` (created by the seed
script, gitignored — it contains a live API key) is the dataset handle the
stages and the invariant checker share.
