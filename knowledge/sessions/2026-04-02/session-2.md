# Session 2 - Rapid Swaps Adoption Chart Midgard Failover + Live Deploy

> Date: 2026-04-02
> Focus: Restore Rapid Swaps adoption charts by hardening the Midgard frontend data source and deploy the fix live.

## Summary

Fixed the Rapid Swaps adoption charts by hardening the frontend Midgard client to fail over from the broken `midgard.thorchain.network` proxy to the canonical `midgard.ninerealms.com` origin when swap-history responses are structurally unusable. Also added a clearer fallback state for the adoption section when THORChain denominator data is unavailable, then deployed the fix live from a clean snapshot so unrelated local edits stayed out of production.

## Work Done

- Confirmed the adoption charts were failing because the frontend denominator fetch path was receiving empty `intervals` from `/history/swaps`, not because the rapid-swap aggregation itself was wrong.
- Verified that the canonical Ninerealms Midgard origin still returned valid hourly/day swap-history buckets while the proxy origin returned empty data for the same requests.
- Patched the shared Midgard client to retry history queries on the fallback origin when the primary response is structurally invalid and to do the same for action queries when the proxy ignores a requested small `limit`.
- Tightened the Rapid Swaps adoption section so it only renders charts when valid percentage series exist; otherwise it shows a plain unavailable-state message instead of blank canvases.
- Added regression tests covering the swap-history and actions failover behavior.
- Built and deployed the updated frontend to `boone.tools` from a temporary clean worktree with only the adoption-chart fix overlaid.

## Discoveries

- `https://midgard.thorchain.network/v2/history/swaps` is currently returning empty `intervals` for valid `interval=hour` and `interval=day` requests, while `https://midgard.ninerealms.com/v2/history/swaps` still returns correct bucketed data.
- The proxy origin can also ignore small `limit` values on `/actions`, which makes it unsafe to trust as the sole Midgard source for client analytics.
- The adoption charts were uniquely sensitive to this because they depend on external THORChain denominator history; the rest of the Rapid Swaps dashboard remained populated from the BooneTools API.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/api/midgard.js` | Added primary/fallback Midgard origins plus response validation and retry logic for broken proxy responses. |
| `src/lib/RapidSwaps.svelte` | Added adoption-data guards so the section renders charts only when valid percentage series exist. |
| `tests/midgard.test.js` | Added regression tests for Midgard history/actions failover behavior. |

## In Progress

Monitor other Midgard-powered frontend views for similar proxy drift and move them onto the same failover path as needed.

## Next Steps

- [ ] Watch the live Rapid Swaps adoption charts for another day-boundary rollover to confirm the failover path remains stable.
- [ ] Check other Midgard-dependent pages for empty-history or ignored-limit proxy behavior and reuse the same client fallback where needed.
- [ ] Retire the remaining Supabase rollback path once the Hetzner observation window closes cleanly.
