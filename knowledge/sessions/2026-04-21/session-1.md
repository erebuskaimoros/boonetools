# Session 1 - BooneTools Production Recovery

> Date: 2026-04-21
> Focus: Rapid Swap ingestion, Bond Tracker recovery, and BooneTools live sync

## Summary

Recovered BooneTools production after Rapid Swap ingestion and Bond Tracker regressions. The live frontend and backend were brought back onto one coherent deployed state, with Bond Tracker, Rapid Swaps, Treasury, and Vault Explorer verified in fresh-cache browser checks.

## Work Done

- Fixed Rapid Swap scheduler failure caused by production missing `rapid_swaps.comparable_volume_usd`.
- Added and applied migration `010_rapid_swaps_comparable_volume.sql`, then backfilled existing rapid-swap rows.
- Recovered Rapid Swap ingestion after official RPC/Midgard endpoints returned 403 from Hetzner.
- Added RPC websocket fallback rotation for the listener and Liquify gateway Midgard/RPC fallbacks.
- Backfilled and reconciled recent Rapid Swap data; final 48h dry run found no missing swaps.
- Fixed Bond Tracker frontend initialization by removing dependency on Midgard `/bonds/{address}` for current bond discovery.
- Fixed backend `bond-history` by deriving current bond nodes from THORNode node provider data.
- Added cached `bond-history` fallback for transient Midgard `/churns` failures.
- Deployed the frontend and backend to `boone.tools`.
- Verified production services and fresh-cache browser routes for Bond Tracker, Rapid Swaps, Treasury, and Vault Explorer.

## Discoveries

- The former Chainnet Midgard and RPC WebSocket hosts could return 403 from the Hetzner host, so production needs tested fallback endpoints.
- Midgard `/bonds/{address}` is not reliable enough for Bond Tracker initialization; THORNode `/thorchain/nodes` bond provider data is the safer current-state source.
- Bond history should serve cached rows on transient churn-list failures instead of surfacing a 500, because cached churn rows are still useful and usually complete.
- Liquify Midgard first-page `/actions` scans need `offset=0`; without it the gateway returned `500 Too many hops`.
- Deploying backend code and migrations out of sync can break scheduler jobs even when the frontend is healthy.

## Files Changed

| File | Change |
|------|--------|
| `website/backend/migrations/010_rapid_swaps_comparable_volume.sql` | Added comparable volume column, historical backfill, and index. |
| `website/backend/src/handlers/rapid-swaps.js` | Returned two-leg comparable volume semantics and backend health metadata. |
| `website/backend/src/handlers/bond-history.js` | Switched current bond discovery to THORNode and added stale cached response fallback. |
| `website/backend/src/lib/config.js` | Added RPC websocket URL lists and gateway fallback defaults. |
| `website/backend/src/listener.js` | Added RPC websocket fallback rotation. |
| `website/backend/src/shared/bond-history.js` | Treated aborts as transient historical fetch failures. |
| `website/backend/src/shared/midgard.js` | Increased Midgard timeout for backend calls. |
| `website/src/lib/BondTrackerV2.svelte` | Removed browser-side Midgard bond dependency for initial bond-node discovery. |
| `website/src/lib/RapidSwaps.svelte` | Updated dashboard behavior for cumulative chart/volume semantics and deployed state. |
| `website/src/lib/rapid-swaps/backend.js` | Added gateway-safe Midgard action request shape and provider fallbacks. |
| `website/src/lib/rapid-swaps/charts.js` | Fixed cumulative chart seeding and axis behavior. |
| `website/src/lib/rapid-swaps/model.js` | Added comparable two-leg volume support. |
| `website/src/lib/rapid-swaps/volume.js` | Centralized rapid-swap comparable volume helpers. |
| `website/scripts/deploy-boonetools-backend.sh` | Hardened backend deploy defaults and env generation. |
| `website/scripts/deploy-boonetools-frontend.sh` | Added guarded frontend deploy path for canonical repo. |
| `website/scripts/require-canonical-boonetools-repo.sh` | Added deploy guard to prevent pushing from the wrong repo. |
| `website/tests/rapid-swaps*.test.js` | Added coverage for rapid-swap backend, charts, and volume semantics. |
| `../knowledge/projects/boonetools.md` | Added evergreen production/provider notes. |
| `../knowledge/log.md` | Logged production recovery and provider hardening discoveries. |

## In Progress

None - session complete.

## Next Steps

- [ ] Keep an eye on Rapid Swap scheduler logs for provider flakiness after the next few timer runs.
- [ ] Consider moving all browser-side Midgard calls behind the BooneTools backend for consistent provider fallback behavior.
- [ ] Add a production smoke-test script that checks Bond Tracker, Rapid Swaps, Treasury, and Vault Explorer after every deploy.
- [ ] Revisit pending Rapid Swap candidate backlog and decide whether old unresolved candidates should expire faster.
