# Session 2 - App Layer Collector Revenue Correction

> Date: 2026-05-17
> Focus: Production deploy follow-up and dev correction for Rujira app-collector lifetime revenue

## Summary

Deployed the App Layer to Base Layer dashboard to production, verified dev/prod parity, then updated the dev dashboard with THORChain.net links and all-time app-collector revenue estimates. The latest correction changes collector cards from current holdings to lifetime net collected, calculated as historical distributions out of each collector plus current residual balances.

## Work Done

- Deployed the `/app-layer-base-layer` dashboard build to `https://boone.tools/app-layer-base-layer` and verified the route in production.
- Confirmed dev and production matched for the previously deployed dashboard data and rendered key fields.
- Added THORChain.net links for collector addresses, targets, Reserve path, contract history, similar contracts, and Reserve-payment tx rows.
- Added `scripts/rujira-collector-revenue.mjs` to generate an all-time app-collector revenue artifact.
- Corrected the dashboard collector cards to show all-time collected rather than current collector holdings.
- Rebuilt the site and verified the local dashboard shows the corrected values with no page console errors.

## Discoveries

- The first "net collected" implementation was wrong because it valued only current collector balances.
- The practical all-time collector estimate is a conservation-style measure: all outbound distributions from the collector after the Rujira fee-share start height plus any current residual collector balances.
- The all-time collector artifact currently estimates RUJI Trade at about $21.7k, Other Core Apps at about $16.9k, and RUJI Swap at about $105.8k using current THORNode pool TOR prices.
- RUJI Index currently holds or distributed only unpriced NAMI/index receipt-token denoms in this accounting, so the dashboard labels it `unpriced` instead of `$0`.
- The latest collector-revenue correction is committed for the dev branch but has not been redeployed to production.

## Files Changed

| File | Change |
|------|--------|
| `website/src/lib/AppLayerBaseLayerDashboard.svelte` | Added THORChain.net links and all-time app-collector revenue display |
| `scripts/rujira-collector-revenue.mjs` | New generator for lifetime collector distributions plus residual balances |
| `website/public/data/rujira-base-layer-fees/rujira-collector-revenue.json` | Generated collector-revenue artifact consumed by the dashboard |
| `knowledge/sessions/_index.md` | Added this session to the recent session index |
| `knowledge/sessions/2026-05-17/session-2.md` | Captured this session handoff |
| `../knowledge/projects/boonetools.md` | Recorded the production dashboard and collector-revenue artifact behavior |
| `../knowledge/projects/rujira.md` | Recorded the app-collector lifetime revenue accounting interpretation |
| `../knowledge/log.md` | Appended the shared wiki update entry |

## In Progress

The latest dev correction has not been deployed to production. Production still reflects the prior dashboard deploy unless a new deploy is run from the updated branch.

## Next Steps

- [ ] Deploy the updated all-time collector-revenue dashboard to production if desired.
- [ ] Decide whether to build a historical USD-at-receipt pricing pipeline instead of current-pool-price estimates.
- [ ] Add a regeneration command or npm script for refreshing both Reserve-payment and collector-revenue artifacts.
- [ ] Consider adding a warning or drilldown for unpriced receipt-token denoms.
