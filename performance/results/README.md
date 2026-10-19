# Raw performance evidence, committed as-is.

- `NN-<stage>.json` — k6 end-of-test summary exported by each stage's
  `handleSummary` (full metric data: counts, rates, percentiles incl. p99,
  thresholds).
- `NN-<stage>.txt` — the same stage's console output (live summary + logs),
  captured via cmd redirection on the host.
- `07-account-scaling*.txt/json` — the eight-account scaling stage at three
  operating points: default pool (10 connections), `POOL_MAX=50`, and a
  200-VU saturation probe; together they isolate the api pool and host CPU
  as the ceilings beyond per-account locking.
- `explain-*.txt` — `EXPLAIN (ANALYZE, BUFFERS)` captures for the hot queries,
  taken against the compose db (before/after the history-index fix).
- `consume-breakdown.txt` — the api→db round-trip probe and the arithmetic
  showing what dominates the serialized consume path.
- `environment.md` — host/tool versions and run parameters, so the numbers
  above are reproducible.

`loadtest-state.json` (the seeded dataset handle with live API keys) is
gitignored on purpose; `npm run bench:seed` recreates or extends it.
