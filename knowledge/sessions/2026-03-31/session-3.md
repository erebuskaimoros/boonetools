# Session 3 - Repo Restructure + Rapid Swaps Catchup

> Date: 2026-03-31
> Focus: Restructure boonetools public repo, diagnose and fix rapid swaps data gaps vs Raynalytics

## Summary

Restructured the `erebuskaimoros/boonetools` GitHub repo to contain the actual website source code (previously it only had stale content while the website lived in a parent monorepo). Then compared the Rapid Swaps dashboard against Raynalytics, discovered a ~270 swap gap caused by the scheduler's fixed 20-page scan window, and ran a catchup to close it from 1,933 to 2,201 swaps (Raynalytics: 2,205). Deployed an adaptive scheduler that prevents future gaps.

## Work Done

- Initialized a fresh git repo in `website/`, pushed to `erebuskaimoros/boonetools` as `main`
- Updated `.gitignore` to exclude `.env`, sessions, `.claude/`, `node_modules`, `dist`
- Updated footer source link to point to `https://github.com/erebuskaimoros/boonetools`
- Compared boone.tools Rapid Swaps dashboard (1,933 swaps) vs Raynalytics (2,205 swaps)
- Identified root cause: scheduler only scanned 20 pages (1,000 actions) every 5 min — high-frequency trade-account swaps were buried thousands of actions deep
- Built and ran `scripts/catchup-rapid-swaps.mjs` — found 268 missed swaps, upserted 264 to Supabase (4 lost to script kill timing)
- 89% of missed swaps were trade-account swaps (`~` notation), mostly small BSC USDT/BTCB → BTC/LTC
- Patched scheduler to adaptive scanning: fetches 2,000 recent known tx_ids, scans up to 200 pages, stops after 3 consecutive pages of all-known swaps
- Deployed updated scheduler to Supabase
- Added diagnostic logging to WebSocket listener for trade-account event visibility

## Discoveries

- The git root is at `/THORChain/` (the monorepo), not `/THORChain/boonetools/` — `boonetools/` and `website/` are subdirs. The website needed its own git repo for clean public hosting.
- Trade-account swaps (`BSC~USDT`, `BCH~BCH`, etc.) are the primary source of missed rapid swaps — they're high-frequency, low-value, and the WebSocket listener likely doesn't receive `streaming_swap` events for them (or events lack `tx_id`).
- The 20-page scheduler window was only covering ~1,000 of the most recent actions. During busy periods, rapid swaps were buried 4,000–35,000+ actions deep in the Midgard history.
- `gh auth setup-git` configures the `gh` credential helper but doesn't override an existing `osxkeychain` helper in global git config. Need `git config credential.helper '!/usr/bin/gh auth git-credential'` per-repo.

## Files Changed

| File | Change |
|------|--------|
| `website/.gitignore` | Added `.claude/`, `knowledge/sessions/` exclusions |
| `website/src/lib/Footer.svelte` | Updated source link to repo root |
| `website/supabase/functions/_shared/rapid-swaps.ts` | Adaptive scanning with `knownTxIds` + early stop on overlap |
| `website/supabase/functions/rapid-swaps-scheduler/index.ts` | Fetch known tx_ids, bump default to 200 pages, pass to scanner |
| `website/scripts/rapid-swap-listener.mjs` | Diagnostic logging for trade-account streaming_swap events |
| `website/scripts/catchup-rapid-swaps.mjs` | New one-time catchup script with incremental upserts |

## In Progress

- WebSocket listener diagnostic logging needs restart on server to take effect
- 4 rapid swaps from deep history not upserted (script killed before final flush)
- TradingView Advanced Charts form still needs filling (requires personal details)

## Next Steps

- [ ] Restart the WebSocket listener on the server to activate trade-account event logging
- [ ] Review listener logs to confirm whether trade-account swaps emit `streaming_swap` events
- [ ] If trade-account events have no `tx_id`, add block-height-based Midgard lookup to the listener
- [ ] Fill out TradingView Advanced Charts form (need name, email, GitHub, job title, phone, country)
- [ ] Test that the adaptive scheduler correctly stops early on the next 5-min run
