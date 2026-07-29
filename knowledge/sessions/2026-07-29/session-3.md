# Session 3 - Pool Dislocation Dashboard

> Date: 2026-07-29
> Focus: Exact five-minute THORChain pool-price dislocation against Oracle and Binance

## Summary

Built a production-backed `/pool-dislocation` dashboard that samples every
Available THORChain pool on exact UTC five-minute boundaries and compares its
pool price with independently aligned Oracle and Binance references. The
dashboard exposes exact seven-day selected-pool points, 1h/4h/1d/3d/7d
absolute-deviation metrics, and a default-on filter for trading-halted chains.

## Work Done

- Added 30-day Postgres observation retention, the five-minute isolated job,
  compact read model, bounded selected-series route, and public server routes.
- Added explicit asset-to-Oracle/Binance mappings while keeping unmapped pools
  visible with partial or THORChain-only coverage.
- Preserved exact five-minute timestamps and source gaps without interpolation
  or carry-forward; source alignment is capped at 30 seconds.
- Added the terminal-style dashboard, all Available-pool search/coverage
  filters, reference toggles, thresholds, chart, and ABS windows.
- Added a default-on `HIDE HALTED` control that recalculates dashboard leaders,
  coverage, threshold totals, and selected-pool fallback.
- Integrated trading state with the canonical `thornode-core:v1`
  `inbound_addresses` field. Missing or stale state degrades visibly and never
  hides a pool.
- Added systemd units, backend priming, environment/deployment docs,
  performance gates, and frontend surface accounting.
- Verified a real temporary Postgres migration/job/API path, live THORNode and
  Binance sampling, browser interactions, 187 backend tests, 158 frontend
  tests, repository checks, and the production build.

## Discoveries

- Every Available pool should be retained even when an exact Oracle or Binance
  mapping is unavailable; hiding unsupported pools would make coverage look
  healthier than it is.
- The selected seven-day series must remain exact and gap-preserving, while the
  all-pool summary can use peak-preserving hourly sparklines for payload size.
- Trading-halt filtering must consume the shared durable core snapshot rather
  than introduce another request to `/thorchain/inbound_addresses`.
- A new read-model timer also needs an explicit deploy-time prime step when its
  endpoint participates in immediate post-switch performance gates.

## Files Changed

| File | Change |
|------|--------|
| `backend/migrations/031_pool_dislocation.sql` | Added durable five-minute observations and indexes. |
| `backend/src/shared/pool-dislocation.js` | Added mappings, normalization, exact metrics, chain trading state, summaries, and selected series. |
| `backend/src/jobs/pool-dislocation-scheduler.js` | Added aligned provider collection, canonical core-state reuse, persistence, retention, and publication. |
| `backend/src/handlers/pool-dislocation.js` | Added provider-free summary and bounded series handlers. |
| `backend/src/server.js` | Registered the public routes. |
| `backend/src/run-job.js` | Registered the isolated scheduler. |
| `backend/src/lib/config.js` and `backend/.env.example` | Added Binance public market-data configuration. |
| `src/lib/PoolDislocation.svelte` | Added the production dashboard and default-on halted-chain filter. |
| `src/lib/pool-dislocation/` | Added frontend API and presentation models. |
| `src/App.svelte` | Added navigation and route loading. |
| `backend/tests/pool-dislocation.test.js` and `tests/pool-dislocation.test.js` | Added backend and frontend contract coverage. |
| `ops/systemd/boonetools-pool-dislocation.*` | Added exact five-minute production scheduling. |
| `scripts/deploy-boonetools-backend-remote.sh` and `scripts/perf-smoke.mjs` | Added read-model priming and production performance verification. |
| `README.md`, `docs/`, and `knowledge/pool-dislocation.md` | Documented the production contract and operations. |

## In Progress

Implementation is complete and verified. Production rollout follows this
commit; seven-day history will accumulate from the first deployed sample.

## Next Steps

- [ ] Monitor the first seven days of exact five-minute sample completeness.
- [ ] Watch Oracle, Binance, and core trading-state freshness independently.
- [ ] Review new asset mappings as Available pool composition changes.
- [ ] Revisit thresholds after enough production history exists to characterize normal basis noise.
