# Raw performance evidence, committed as-is.

All captures are from the 2026-10-22 run set (the lineage of earlier run
sets is in `environment.md`).

- `NN-<stage>.json` — k6 end-of-test summary exported by each stage's
  `handleSummary` (full metric data: counts, rates, percentiles incl. p99,
  thresholds).
- `NN-<stage>.txt` — the same stage's console output (live summary + logs),
  captured via cmd redirection on the host.
- `07-account-scaling-pool50.*` — the scaling stage re-run with the api
  pool raised to 50, for the pool comparison against the default-pool run.
- `08-capacity-vus*.txt/json` — the capacity sweep (fixed client counts,
  10 → 1000) whose table is in `../README.md`.
- `09-saturation.*` — the fixed-arrival-rate overload run.
- `02-baseline-before-history-fix.*`, `05-mixed-before-history-fix.*` —
  kept from the original 2026-10-18 set as the "before" side of the
  history-index fix.
- `explain-*.txt` — `EXPLAIN (ANALYZE, BUFFERS)` captures: the hot queries
  before/after the history-index fix, the removed request-cap COUNT (the
  reason the usage counters exist), and the current statement-by-statement
  consume-path audit.
- `consume-breakdown.txt` — the four-way cost probe (round trips vs
  durability vs execution) and the arithmetic splitting the serialized
  consume path.
- `environment.md` — host/tool versions and run parameters, so the numbers
  above are reproducible.

`loadtest-state.json` (the seeded dataset handle with live API keys) is
gitignored on purpose; `npm run bench:seed` recreates or extends it.
