# Session 1 - BooneTools Midgard Usage Reduction

> Date: 2026-04-23
> Focus: Reduce Midgard load across BooneTools and deploy the cached API paths

## Summary

Moved the remaining high-impact browser Midgard usage behind the Hetzner BooneTools API and deployed the backend/frontend live. Rapid Swap adoption history now uses a cached backend endpoint, Bond Tracker transaction hash lookup now uses cached backend bond events, and shared Midgard clients stop immediately on 429s instead of probing fallbacks.

## Work Done

- Added the `012_midgard_usage_cache.sql` migration with generic API response caching and cached bond tx event tables.
- Added a backend response cache helper and a new `/functions/v1/rapid-swaps-swap-history` route for cached Rapid Swap market-share history.
- Moved Bond Tracker bond/unbond tx hash lookup from direct browser Midgard scans into `bond-history?include_bond_txs=true`.
- Updated frontend Rapid Swaps and Bond Tracker call sites to use the cached backend API responses.
- Hardened frontend and backend Midgard helpers to stop immediately on 429 and avoid fallback probing that multiplies rate-limit violations.
- Ran backend tests, targeted frontend tests, full `npm test`, production build, backend deploy, frontend deploy, and live API smoke checks.
- Updated the shared THORChain knowledge page and log with the new Midgard-reduction operational notes.

## Discoveries

- The deploy scripts report dirty local files but only ship the backend/shared runtime paths and `dist/`, so unrelated local edits can remain unstaged while production still receives the intended committed code.
- The Hetzner DB already had the new cache migration applied before the final deploy, and the deploy script correctly skipped it as already applied.
- Live `rapid-swaps-swap-history` returned fresh cached data, and live `bond-history` returned history plus a non-empty `bond_tx_map` after the bond tx event cache was populated.
- The website repo has a malformed local Git credential helper that prints `git: 'credential-!/usr/bin/gh' is not a git command`, but pushes still completed after authentication.

## Files Changed

| File | Change |
|------|--------|
| website/backend/migrations/012_midgard_usage_cache.sql | Added backend cache and bond tx event tables |
| website/backend/src/shared/response-cache.js | Added generic Postgres-backed API response cache helper |
| website/backend/src/shared/midgard.js | Added 429-aware Midgard behavior and cached swap-history helper |
| website/backend/src/handlers/rapid-swaps-swap-history.js | Added cached Rapid Swap swap-history endpoint |
| website/backend/src/handlers/bond-history.js | Added cached bond tx event scanning and `include_bond_txs` response support |
| website/backend/src/server.js | Registered the new rapid-swap swap-history route |
| website/src/lib/rapid-swaps/api.js | Added frontend API helper for cached swap-history |
| website/src/lib/RapidSwaps.svelte | Moved adoption history loading off direct Midgard |
| website/src/lib/BondTrackerV2.svelte | Removed direct Midgard bond tx hash scanning |
| website/src/lib/api/midgard.js | Stopped fallback probing on Midgard 429s and removed Nine Realms fallback default |
| website/src/lib/utils/api.js | Added rate-limit stop behavior to shared fetch fallback helper |
| website/backend/tests/midgard.test.js | Covered backend stop-on-429 behavior |
| website/tests/bond-tracker-midgard.test.js | Updated frontend Midgard fallback test expectations |
| ../knowledge/projects/boonetools.md | Added evergreen operational notes for cached Midgard-heavy paths |
| ../knowledge/log.md | Logged the site-wide Midgard usage reduction |

## In Progress

None for this session. Unrelated local website edits remain intentionally unstaged in `docs/style.md`, `package.json`, and `DESIGN.md`.

## Next Steps

- [ ] Monitor Hetzner `boonetools-api` and `rapid-swap-listener` logs for any renewed Midgard 429s.
- [ ] Watch `api_response_cache` and `bond_tx_events` growth and add pruning if usage grows faster than expected.
- [ ] Review lower-priority pages for remaining direct Midgard use if the provider reports more pressure.
- [ ] Clean up existing Svelte build warnings separately from this provider-hardening work.
