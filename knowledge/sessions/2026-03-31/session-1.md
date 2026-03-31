# Session 1 - Rapid Swaps Adoption Fix + Deploy

> Date: 2026-03-31
> Focus: Fix Rapid Swaps adoption chart accuracy, harden the recorder pipeline, and deploy the stack

## Summary

Fixed two adoption-chart accuracy issues in the Rapid Swaps dashboard: daily bucketing now matches Midgard's UTC-day history, and non-RUNE swap volume is now compared on a leg-counting basis instead of a single input-side notional. Also hardened the rapid-swap recorder/scheduler/listener flow for missed swaps and deployed the frontend, Supabase functions, and listener service.

## Work Done

- Reproduced the adoption-chart mismatch with a timezone-sensitive regression test before changing chart logic
- Extracted Rapid Swaps daily aggregation into a dedicated helper module and switched chart day keys to UTC to match Midgard history
- Updated adoption volume math so non-RUNE swaps contribute both priced legs while RUNE-paired swaps remain single-leg
- Added chart tests covering UTC day alignment, non-RUNE double-leg adoption volume, and RUNE single-leg behavior
- Increased scheduler scan depth, added overlap-based early stopping, and surfaced `stopped_early` stats in the scheduler payload
- Hardened the WebSocket listener to fall back to `tx_hash` and log skipped/incomplete rapid-swap events more explicitly
- Added a one-off catchup script to backfill missed rapid swaps from Midgard into Supabase
- Deployed Supabase functions, restarted the rapid-swap listener service on Hetzner, built the site with `/boonetools/` base, and rsynced the static output to `/var/www/boonetools/`

## Discoveries

- Midgard `history/swaps` day buckets are UTC-based, so local-date grouping makes adoption percentages compare different 24-hour windows under the same label
- Midgard total swap volume appears to be pool-leg volume; for non-RUNE asset-to-asset swaps, matching that denominator requires counting both priced legs in the adoption numerator
- The rapid-swap scheduler can stop much earlier once it overlaps several pages of already-known tx IDs instead of rescanning a fixed deep window every run
- Tendermint `streaming_swap` events do not always expose `tx_id`; some completions arrive with `tx_hash`, so the listener needs both

## Files Changed

| File | Change |
|------|--------|
| src/lib/RapidSwaps.svelte | Switched adoption chart date filtering to shared UTC chart helpers and clarified UTC grouping in the UI |
| src/lib/rapid-swaps/charts.js | Added extracted daily chart aggregation with UTC bucketing and leg-based adoption volume comparison |
| tests/rapid-swaps-charts.test.js | Added regression tests for UTC day matching and adoption-volume leg counting |
| supabase/functions/_shared/rapid-swaps.ts | Added known-tx overlap detection, deeper scanning, and early-stop reporting for recorder fetches |
| supabase/functions/rapid-swaps-scheduler/index.ts | Loaded recent tx IDs before scanning and recorded `stopped_early` scheduler stats |
| scripts/rapid-swap-listener.mjs | Added `tx_hash` fallback and more explicit logging for skipped or incomplete rapid swaps |
| scripts/catchup-rapid-swaps.mjs | Added one-off historical catchup script to backfill missed rapid swaps into Supabase |

## In Progress

None - session complete.

## Next Steps

- [ ] Monitor `rapid-swaps-scheduler` runs to confirm the new early-stop logic reduces scan depth without missing swaps
- [ ] Watch `rapid-swap-listener` logs for `tx_hash` fallback events and confirm they are being recorded successfully
- [ ] Consider switching rapid-swap USD estimation from observation-time pricing to historical swap-time pricing for tighter volume accuracy
- [ ] Run the catchup script if recorder history still shows gaps before 2026-03-22
