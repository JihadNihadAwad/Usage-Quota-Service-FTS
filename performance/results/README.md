# Raw performance evidence, committed as-is.

- `NN-<stage>.json` — k6 end-of-test summary exported by each stage's
  `handleSummary` (full metric data: counts, rates, percentiles incl. p99,
  thresholds).
- `NN-<stage>.txt` — the same stage's console output (live summary + logs),
  captured via cmd redirection on the host.
- `explain-*.txt` — `EXPLAIN (ANALYZE, BUFFERS)` captures for the hot queries,
  taken against the compose db (before/after the history-index fix).
- `consume-breakdown.txt` — the api→db round-trip probe and the arithmetic
  showing what dominates the serialized consume path.
- `environment.md` — host/tool versions and run parameters, so the numbers
  above are reproducible.

`loadtest-state.json` (the seeded dataset handle with live API keys) is
gitignored on purpose; `npm run bench:seed` recreates or extends it.
