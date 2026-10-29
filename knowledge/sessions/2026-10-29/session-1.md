# Session 1 - Financials recovery, RPC config and day-detail rankings

> Date: 2026-10-29 (session ran 2026-10-25 to 2026-10-29)
> Focus: Restore missing Financials data after THORNode 3.21.0, fix the server RPC route, and rebuild the day-detail top pools and top swaps

## Summary

Restored the Financials and cross-chain comparison charts after THORNode 3.21.0 by reviewing its reward formula and fixing a repair loop that starved the backlog. Switched the server's RPC route away from a keyed URL that returned 403. Rebuilt the Financials day detail: pools now come from Pool Analysis, top swaps come from a finalized-block ledger verified against Midgard, and the swaps table shows fees and fee rate. Everything is deployed (backend and frontend `c19a5bb`).

## Work Done

- Earlier in the session (Oct 25 to 26): trimmed and merged the worktree keepers port (`0a52f88`), reconciled local `main`, committed and deployed the chain-event broker heartbeat fix and slow-block notes (`0a42632`, `7de5a7b`), and removed seven stale worktrees.
- Investigated the App Layer dashboard: lane 03 only tracks the Rujira VS swap contract, which stopped swapping on Sep 26 (block 27987943). No collector bug.
- **Reserve emissions after 3.21.0:**
  - Every block from 28366100 had been deferred as an unsupported version.
  - The 3.21.0 change accepts the reviewed version (`a236f9d`), and the next one anchors the largest repair chunk first (`bb29649`). Both were written test-first.
  - Oct 23 to 26 recovered, and the comparison collector reran with 390 of 390 days.
- **RPC route:**
  - Backed up `backend.env` to `backend.env.bak-2026-10-27-rpc-rest-url` and pointed `RPC_REST_URL` at the public Liquify RPC.
  - Restarted the API, chain-stream listener and Financials collector. RPC 403s went to zero.
- **Reconciliation adjustment:** traced the post-Oct 23 jump to the RUJI pool. It is investigation only, not documented in the site yet.
- **Day-detail pools:**
  - Oct 27's closing pass accepted stale zero Midgard buckets for 18 pools.
  - Reads now rank Pool Analysis totals, and the collector only fetches pools Pool Analysis does not track. The old exact-match cache is removed (`087e2f4`).
- **Day-detail swaps:**
  - The Midgard `/actions` scan made no requests from about 12:00 to 24:00 UTC on Oct 27, so 6 of the real top 10 were missing.
  - Added a finalized-block swap ledger (`54ed8e5`, migration 073).
    - Streams are recorded at their first sub-swap, which sets the day, and at completion, which sets the size from the deposit at that block's RUNE rate.
    - Each completed swap among a day's top 25 is verified in Midgard by tx ID.
  - Days starting after migration 073 (from 2026-10-30 UTC) skip the actions scan.
- **Fees and rate:** the swaps table gets FEES and RATE (bps) columns (`ceacc82`, migration 074). The swap name links to the transaction, and the TX column is removed. Fees come from Midgard `liquidityFee`, valued at the swap's 15-minute Pool Analysis RUNE price. Rows stored earlier are filled once into `financials_swap_fees`.
- **Merges and deploys:** merged both day-detail branches with the overlap resolved (`6ecb0ef`). Deployed backend `7de5a7b`, `a236f9d`, `bb29649`, `6ecb0ef` and `c19a5bb` (the last two coordinated, for their migrations), plus frontend `c19a5bb`.
- **Cleanup:** removed the merged worktrees `day-pool-floor`, `day-swaps-stream`, `reserve-emissions-3-21` and `day-swap-fees`. Their branches are kept.
- **Papercut review (bounded):** 96 open overall, 5 from this repo since Oct 25. `pc-20261029-030957-7205f2` (Postgres tests hand-list their migrations) caused repeated test-setup edits this session. It is still open.

## Discoveries

- **THORNode 3.21.0 reward formula:** `calcBlockRewards` is byte-identical to 3.20.3. The upgrade block's `version` event is the only reviewed transition.
- **The local `v3.21.0` tag differs from upstream.** Upstream refs were fetched under `refs/upstream/`.
- **Reconciliation adjustment = RUJI LP share kept in the Reserve.** Promote to `knowledge/financials.md`.
  - `getAvailablePoolsRune` skips native THOR.* pools, so RUJI's fee-weighted LP share is never paid or emitted.
  - Midgard nets the full RUJI fee out of that pool's earnings, so its reported earnings come out lower by that slice.
  - The ratio matched every day since Oct 7, and per block to within 1 e8.
- **Liquify Midgard can return wrong data that looks valid.** Its load-balanced backends occasionally serve well-formed empty buckets and intermittent `/v2/health` 500s, so a single response needs an invariant check.
- **Midgard swap status:** a swap action stays `pending` until its outbound is observed, even after the swap has completed on THORChain.
- **Midgard fee fields:** `liquidityFee` is RUNE in e8 units. `swapSlip` closely tracks the effective fee rate in bps.
- **Streaming swap events:**
  - `streaming_swap` is emitted on completion and carries the full `deposit`.
  - The first executed sub-swap has `streaming_swap_count` = 1.
  - About 15% of completion blocks have no sub-swap of their own, mostly fully refunded streams.
- **`oracle_price` events:** they appear in transaction results, but not in every block.
- **CI naming:** the workflow is named `CI`; its job is `verify`.

## Files Changed

| File | Change |
|------|--------|
| backend/src/shared/financials-reserve-emissions.js, financials-reserve-service.js | Reviewed 3.21.0 transition; largest repair chunk first |
| backend/src/shared/financials-day-detail.js | Pool Analysis pool merge, swap-ledger read path, fee pricing, collector options |
| backend/src/shared/financials-swap-candidates.js | New: block parser, verifier, ledger reads, fee fill |
| backend/src/shared/financials-reward-source.js | Candidates written in the same statement as reward blocks |
| backend/src/shared/financials-day-source.js | Removed (exact-match Pool Analysis cache) |
| backend/src/jobs/financials.js | Verifier and fee-fill loop; single day-detail request |
| backend/migrations/073_financials_swap_candidates.sql, 074_financials_swap_fees.sql | Swap ledger and fee backfill tables |
| src/lib/financials/DayDetail.svelte | FEES and RATE columns; swap name links to the transaction |
| backend/tests/* | Tests for 3.21.0, repair order, pools, swap ledger and fees |
| knowledge/financials.md, docs/deployment.md | Day-detail sources, 3.21.0 review, deploy notes |
| Server `backend.env` | `RPC_REST_URL` moved to the public Liquify RPC (backup kept) |

## In Progress

- **Swap ledger coverage:** it starts with 2026-10-30 UTC. The first covered day's panel has not been observed yet.
- **Fee fill:** about 120 stored rows are being filled at 5 every 30 seconds.
- **Oct 27 swaps:** still the stalled scan's incomplete list, since that day predates the ledger.
- **Invalid key:** `RUJIRA_BASE_FEES_RPC_URLS` and `RUJIRA_RESERVE_PAYMENTS_RPC_URLS` still list the invalid keyed Liquify URL first, which costs one failed call before NativeSwap.

## Next Steps

- [ ] After 00:00 UTC Oct 30, confirm the Oct 30 panel ranks verified ledger swaps and that no `/actions` scan runs for it
- [ ] Decide whether to move the two Rujira RPC lists off the invalid keyed URL
- [ ] Document the RUJI LP-share finding in `knowledge/financials.md` and reword the adjustment tooltip
- [ ] Optionally rescan Oct 27's swaps once through the old Midgard path
- [ ] Revisit App Layer lane 03 (all App Layer swap contracts, coverage through today)
