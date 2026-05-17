# Session 1 - App Layer to Base Layer Dashboard

> Date: 2026-05-17
> Focus: Local BooneTools dashboard for Rujira App Layer to THORChain Base Layer fee-share tracking

## Summary

Built a local-dev-only BooneTools dashboard at `/app-layer-base-layer` that visualizes the Rujira App Layer to THORChain Base Layer fee-share path. The page combines generated Reserve-payment artifacts with live THORNode collector config, history, and balance reads so the dashboard shows both final paid amounts and pending Base Layer collector state.

## Work Done

- Added a dev-only BooneTools app registry entry for `App Layer to Base Layer`.
- Added a Vite-only local data endpoint for the generated Rujira payment CSV, event JSON, and metadata artifacts.
- Built a Svelte dashboard with weekly and cumulative observed Reserve-payment charts, current collector route maps, live Base Layer collector balances, latest Reserve deposits, version history, and similar-contract checks.
- Refreshed the generated Rujira Base Layer fee-share artifacts from chain data.
- Verified the dashboard in the in-app browser and confirmed `npm run build` still passes.
- Updated shared THORChain knowledge pages for the BooneTools and Rujira findings.

## Discoveries

- The current observed final Reserve-payment path is Base Layer Collector -> TC Reserve via `MsgDeposit` memo `RESERVE`.
- Trade and Other Core Apps currently split 50% to the Base Layer collector and 50% to the RUJI-side collector, while Swap and Index do not currently target the Base Layer collector.
- The Base Layer collector existed and targeted the Reserve earlier than the first observed final Reserve deposit, so the dashboard separates paid-to-Reserve from pending or allocated collector balances.
- The local in-app browser runtime lacked `btoa` and direct `window.fetch` in page evaluation, so the dashboard uses its own fetch path in app code and a small base64 encoder for CosmWasm smart queries.
- Svelte reactive markup does not reliably re-run helper functions that only indirectly read object state, so route targets and history labels are now explicit derived maps.

## Files Changed

| File | Change |
|------|--------|
| `website/src/lib/AppLayerBaseLayerDashboard.svelte` | New local dashboard for Rujira App Layer to Base Layer payment tracking |
| `website/src/App.svelte` | Added dev-only app registry entry for `/app-layer-base-layer` |
| `website/vite.config.js` | Added local-only data endpoint for generated Rujira payment artifacts |
| `scripts/rujira-base-layer-fees.mjs` | Chain-data generator for observed Reserve-payment artifacts |
| `docs/rujira-base-layer-fees/*` | Generated CSV, event JSON, metadata, SVG, HTML, and README artifacts |
| `../knowledge/projects/rujira.md` | Recorded Rujira revenue-sharing contract and collector-route findings |
| `../knowledge/projects/boonetools.md` | Recorded the local-only BooneTools dashboard and data source pattern |
| `../knowledge/log.md` | Added log entries for the fee-share chart and local dashboard |

## In Progress

None - session complete. The dashboard is intentionally local-only and verified at `http://127.0.0.1:5173/app-layer-base-layer`.

## Next Steps

- [ ] Add an allocated-inflow view that traces payments into the Base Layer collector from Trade and Other Core Apps, not only final Reserve deposits.
- [ ] Add asset price coverage for non-RUNE, non-stable pending balances if the dashboard needs fuller pending-value accounting.
- [ ] Decide whether the local dashboard should remain dev-only or become a protected/internal production route.
- [ ] Add an explicit refresh action for regenerating the artifact data from the dashboard or a documented npm script.
