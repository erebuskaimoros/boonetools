# Session 1 - Live System Income Burn Tracker

> Date: 2026-08-23
> Focus: Build and deploy a block-live RUNE burn dashboard for `SYSTEMINCOMEBURNRATEBPS`

## Summary

BooneTools now has a deployed `/burn-tracker` dashboard that reports route-specific RUNE burned, current RUNE supply, and the active burn rate. The historical chart combines daily and cumulative burn series, optional RUNE price, preset ranges, and zoom controls. Daily backfill remains the canonical ledger while the consolidated chain stream applies each new block's `rewards.income_burn` exactly once and reconciles periodically with the persisted API model.

## Papercuts

- Resolved: `pc-20260823-123254-13e824` by adding a deployment contract test and stripping macOS xattrs and metadata from emergency backend archives; verified with the focused Node test and a real archive-creation check.
- Deferred: The remaining 29 open entries are pre-existing workflow, provider, environment, or larger deployment improvements outside this Burn Tracker commit.
- Remaining open: 29.

## Work Done

- Added migrations for the daily system-income burn ledger and per-height burn amounts on consolidated chain headers.
- Built the burn parser, historical ingestion, persisted read model, API handler, scheduled refresh, and resumable backfill service.
- Extended the consolidated listener and SSE payload with per-block system-income burn amounts.
- Built the responsive Burn Tracker cards and chart with 30-, 90-, 180-day, all-time, drag-zoom, daily, cumulative, and optional price controls.
- Applied live blocks exactly once in the frontend and retained periodic API reconciliation for missed events or reconnects.
- Added Burn Tracker to desktop and mobile navigation.
- Documented data provenance, service ownership, deployment behavior, and operational checks.
- Deployed backend release `907be439a5e1-unverified-20260823T122638Z` and frontend release `907be439a5e1-unverified-20260823T123057Z`.
- Verified the live page advanced from block 27,546,510 to 27,546,511 without refresh and updated burned RUNE from 2,011,150.04 to 2,011,150.10.
- Passed 221 frontend tests, 320 backend tests, Svelte checks with no errors, a production build, and whitespace validation.

## Discoveries

- Midgard action history provides the durable historical ledger, while THORNode `rewards.income_burn` provides the lowest-latency per-block delta.
- A unique height key in the persisted chain-header table gives the live overlay durable deduplication and restart safety.
- The live overlay must remain separate from the daily aggregate until API reconciliation to avoid double counting at UTC day boundaries.
- The deployed API reported the burn lane current through height 27,546,514 with a 5% rate and a non-stale per-block overlay.

## Files Changed

| Area | Files and change |
|------|------------------|
| Database | `backend/migrations/049_system_income_burn_tracker.sql` and `050_system_income_burn_blocks.sql` add the daily ledger and per-height burn column |
| Backend | `backend/src/handlers/burn-tracker.js`, `jobs/burn-tracker.js`, and `shared/burn-tracker*.js` implement parsing, ingestion, storage, API modeling, and live overlays |
| Chain stream | `backend/src/listener.js`, `shared/chain-headers.js`, `shared/chain-stream.js`, `shared/thornode-core-snapshot.js`, and frontend stream consumers carry block burn deltas |
| Operations | Burn Tracker systemd units, backend deployment activation, performance smoke coverage, and the emergency archive metadata fix deploy and monitor the lane |
| Frontend | `src/lib/BurnTracker.svelte`, `src/lib/burn-tracker/*`, `shared/burn-tracker/model.js`, and `src/App.svelte` provide the dashboard, chart model, and navigation |
| Tests | Burn Tracker, handler, chain-header, core-snapshot, chain-stream, and deployment contract tests cover historical and live behavior |
| Docs | Backend operations, performance architecture, `knowledge/burn-tracker.md`, and this session record document ownership and semantics |

## In Progress

None - implementation, deployment, and live per-block verification are complete.

## Next Steps

- [ ] Monitor the first UTC rollover to confirm the daily ledger and live overlay reconcile without a visible double count.
- [ ] Watch Burn Tracker timer freshness and consolidated listener lag alongside the existing BooneTools read-model checks.
- [ ] Confirm future `SYSTEMINCOMEBURNRATEBPS` changes appear in the card without requiring a frontend release.
