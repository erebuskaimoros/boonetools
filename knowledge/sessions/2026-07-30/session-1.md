# Session 1 - Pool Dislocation Reliability and Rolling Averages

> Date: 2026-07-30
> Focus: Self-healing exact five-minute sampling and selectable rolling-average overlays

## Summary

Completed and deployed the Pool Dislocation rolling-average chart controls and
made the production data path self-healing. The sampler now retries transient
pool failures inside the same exact five-minute run, can use a recent
independently persisted THORNode core snapshot without presenting it as a fresh
provider read, and automatically reconstructs missing or degraded buckets from
finalized block history. Production BTC now contains all 2,017 expected points
over seven days with zero missing timestamps.

## Work Done

- Added independently selectable signed 1h, 6h, and 1d rolling averages for
  both Oracle and Binance chart series, including matching hover values and
  gap-preserving exact five-minute window semantics.
- Added bounded same-run retries for mandatory `/thorchain/pools` collection;
  retry attempts bypass an unrelated shared cooldown after the first failure.
- Added a pool-specific ordered THORNode provider list so an invalid fallback
  cannot block this sampler while leaving other BooneTools provider contracts
  unchanged.
- Added a three-minute maximum fallback to the independently persisted
  `thornode-core:v1` pool field. Fallback rows retain
  `thornode-core-snapshot` provenance and null any reference outside the
  existing 30-second alignment contract.
- Added a fifteen-minute repair timer that scans the trailing seven days for
  missing buckets, core-fallback rows, and source-wide missing reference legs;
  it reconstructs at most 24 oldest buckets per run using finalized blocks.
- Allowed historical reconstruction to replace only explicitly degraded pool
  or null mapped-reference legs while complete scheduled rows continue to win
  conflicts.
- Added explicit `*-unavailable` and `*-unaligned` reference provenance so
  confirmed historical absence and mismatched time boundaries remain honest
  nulls without being retried indefinitely.
- Deployed frontend release `32a88a92e0177a5aae23bd891e4083c26240365d`
  and final backend release `71d5c1e5a3bcf742d6774b1a495751b1b373a624`.
- Verified the production repair loop converges to zero pending buckets and
  that the API returns 2,017 BTC points with zero five-minute cadence gaps.

## Discoveries

- The apparent missing BTC series combined two distinct conditions: 19 absent
  five-minute buckets caused by failed mandatory pool fetches, plus explicit
  null reference legs. Treating those as one failure mode would either hide
  real source gaps or create misleading cross-time comparisons.
- The configured public THORNode fallback did not resolve from the production
  host. Pool Dislocation now uses its own verified provider list, while a recent
  durable core snapshot supplies an independent short-lived storage fallback.
- Four recoverable Binance closes still cannot be used for dislocation because
  THORChain's finalized block was 35 to 149 seconds from the five-minute market
  boundary. They are correctly labelled `kline-close-unaligned` and remain
  chart gaps under the 30-second alignment rule.
- Three historical THORChain blocks genuinely have no BTC Oracle price. They
  remain null with `thornode-oracle-unavailable` provenance rather than being
  interpolated or replaced with a neighboring block.
- Repair needs explicit negative provenance. Without an unavailable/unaligned
  marker, a confirmed immutable source gap is indistinguishable from a
  transient collection failure and would be retried forever.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/PoolDislocation.svelte` | Added rolling-average controls, chart paths, legends, and hover values. |
| `src/lib/pool-dislocation/model.js` | Added exact contiguous rolling-average construction. |
| `tests/pool-dislocation.test.js` | Added frontend rolling-window and gap regression coverage. |
| `backend/src/jobs/pool-dislocation-scheduler.js` | Added pool retries, cooldown bypass, and durable core fallback provenance. |
| `backend/src/jobs/pool-dislocation-repair.js` | Added the bounded recent-gap repair job. |
| `backend/src/shared/pool-dislocation-backfill.js` | Added exact recent repair planning and explicit unavailable/unaligned reconstruction provenance. |
| `backend/src/shared/pool-dislocation-store.js` | Added guarded replacement of degraded scheduled observations. |
| `backend/src/shared/thornode.js` and `backend/src/lib/config.js` | Added scoped provider selection and reliability settings. |
| `backend/src/run-job.js` | Registered the repair job. |
| `backend/tests/pool-dislocation*.test.js` | Added retry, fallback, repair, provenance, and deployment contract coverage. |
| `ops/systemd/boonetools-pool-dislocation-repair.*` | Added the fifteen-minute production repair schedule. |
| `scripts/deploy-boonetools-backend-remote.sh` | Added deploy-time repair priming before the live sampler. |
| `backend/.env.example` and `docs/boonetools-backend-hetzner.md` | Documented provider, retry, fallback, and repair configuration. |
| `knowledge/pool-dislocation.md` | Promoted the durable sampling and reconstruction contract. |

## In Progress

None. The implementation, production backfill, repair convergence, frontend,
backend, timers, and public API are deployed and verified.

## Next Steps

- [ ] Continue monitoring the shared read-model/provider health dashboard for
  new repair activity or source-wide gaps.
- [ ] Add a second Pool Dislocation THORNode provider only after validating its
  DNS and `/thorchain/pools` response from the production host.
- [ ] Review whether unavailable/unaligned provenance should be exposed as a
  dedicated UI tooltip if users need source-gap diagnostics in the chart.
