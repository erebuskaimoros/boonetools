# Session 1 - Performance, Volume Accounting, and Dynamic Fee Drilldowns

> Date: 2026-07-24
> Focus: BooneTools performance correction, canonical analytics, and ADR26 transaction inspection

## Summary

Completed the performance correction across BooneTools' high-traffic read paths,
standardized backend volume accounting per executed swap leg, and reconciled
Dynamic Fee affiliate fee rates to historical RUNE prices. The ADR26 dashboard
now supports exact selected-pair epoch fee inspection and lazy, volume-sorted
Affiliate Trend transaction drilldowns for day, week, and month buckets.

## Work Done

- Replaced request-time provider fan-out on core dashboards with compact,
  durable read models and isolated provider publishers.
- Hardened backend and frontend deployments around immutable releases, shared
  locking, exact systemd manifests, health gates, and automatic rollback.
- Standardized canonical backend swap volume per executed pool leg while
  retaining explicitly named route-notional presentation exceptions.
- Corrected Affiliate Trend fees/volume to use `earningsRUNE` with matching
  historical daily RUNE prices while retaining `earningsUSD` for fee bars.
- Added day/week/month Affiliate Trend bucketing and halt-aware 30/90/180-day
  volume rolling averages.
- Added exact pair-level epoch transaction fee calculations from THORNode swap
  events and transaction drilldowns from clicked epoch columns.
- Added lazy Affiliate Trend bucket transaction tables, sorted by descending
  volume, with route, time, block, fee, fees/volume, streaming, and status data.
- Updated tests, deployment documentation, performance guidance, and shared
  project knowledge.

## Discoveries

- Midgard historical `earningsUSD` uses the latest RUNE price and is unsuitable
  as a historical fee-rate numerator.
- Stable-to-stable swaps can legitimately use `STABLESLIPMINBPS`, explaining
  SS's low blended fees/volume on June 23 without implicating ADR26 state.
- Exact selected-pair fees require raw THORNode swap events; Midgard's action
  `liquidityFee` is a whole-route value and can include multiple swap legs.
- Transaction detail should remain a bounded, opt-in response so a 400-day
  trend chart does not inherit transaction-level payload or latency.
- Production deploys must activate backend contracts before frontend consumers.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/DynamicFeeDashboard.svelte` | Added chart bucketing, historical fee-rate presentation, epoch and affiliate transaction drilldowns |
| `src/lib/dynamic-fees/model.js` | Added affiliate aggregation, rolling averages, historical price normalization, and transaction presentation |
| `shared/dynamic-fees/affiliate-volume.js` | Added canonical affiliate volume and transaction normalization |
| `shared/dynamic-fees/transactions.js` | Added epoch range, swap-event, and exact pair-fee accounting |
| `backend/src/handlers/dynamic-fee-*.js` | Added cached affiliate and epoch transaction API contracts |
| `backend/src/shared/dynamic-fee-*.js` | Added bounded Midgard/RPC transaction collectors |
| `shared/rapid-swaps/volume.js` | Centralized canonical executed-volume accounting |
| `src/lib/RapidSwaps.svelte` | Preserved intentional route display while using canonical backend totals |
| `src/lib/TCFeeDash.svelte` | Aligned native fee yield with canonical THORChain volume |
| `backend/src/shared/*` | Consolidated durable dashboard read paths and publisher isolation |
| `scripts/deploy-boonetools-*.sh` | Added immutable atomic backend/frontend deployment workflows |
| `ops/systemd/*` | Aligned production services and timers with atomic current releases |
| `docs/*.md` | Documented performance, volume, backend, and deployment contracts |
| `tests/*` and `backend/tests/*` | Added regression coverage across volume, fees, transactions, read models, and deployment |

## In Progress

None - session implementation is complete. Production deployment and
verification follow this session close.

## Next Steps

- [ ] Deploy the backend release and verify all API/domain health gates.
- [ ] Deploy the frontend release and verify the Affiliate Trend drilldown in production.
- [ ] Monitor read-model freshness, provider quotas, and transaction cache behavior.
- [ ] Complete live wallet testing for Limit Orders.
