# Raw performance evidence, committed as-is.

- `NN-<stage>.json` — k6 end-of-test summary exported by each stage's
  `handleSummary` (full metric data: counts, rates, percentiles, thresholds).
- `NN-<stage>.txt` — the same stage's console output (live summary + logs),
  captured with `Tee-Object` on the host.
- `explain-*.txt` — `EXPLAIN (ANALYZE, BUFFERS)` captures for the hot queries,
  taken after the runs against the compose db.
- `environment.md` — host/tool versions and run parameters, so the numbers
  above are reproducible.

`loadtest-state.json` (the seeded dataset handle with a live API key) is
gitignored on purpose; `npm run bench:seed` recreates it.
