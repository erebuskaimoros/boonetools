# Session 1 - Bond History Repair, Endpoint Preference Rollout, and Recorder Hardening

> Date: 2026-04-03
> Focus: Repair live bond-history data, harden rapid-swap ingestion, and prefer official THORChain endpoints with targeted fallback

## Summary

Cleaned the live `bond_history` table by removing poisoned zero rows, backfilling the genuinely missing historical rows, and restoring the missing March 31 churn reward line for the reported screenshot address. Hardened the rapid-swaps backend and repair tooling, then deployed BooneTools live with official `thorchain.network` / `midgard.thorchain.network` endpoints preferred and Nine Realms reserved for fallback and archive use.

## Work Done

- Removed all poisoned `bond_history` rows from the live Hetzner Postgres instance and backed them up before repair.
- Replaced the opaque one-off bond-history repair flow with a logged, incremental repair script that retries, flushes in batches, and reports per-address progress.
- Ran the repair against the deleted-row set and restored `32` real missing rows while classifying `210` deleted rows as legitimate zero-bond periods.
- Restored the missing churn line for `thor1c5q3j23rvjjwkududg9ah2krrjt4emtzzvwj0m` at height `25573978` and verified the live API returned `103` historical rows again.
- Hardened rapid-swap candidate prioritization, reconciliation, and scheduler behavior and carried those backend changes into the session commit.
- Switched backend and frontend runtime preferences to official THORChain endpoints first, with Nine Realms archive for historical height queries and Nine Realms as fallback where needed.
- Fixed the backend deploy script so existing server `.env` files are rewritten on deploy instead of silently retaining stale endpoint values.
- Deployed the backend and a clean frontend snapshot live to `boone.tools` without shipping unrelated local edits.

## Discoveries

- `thornode.thorchain.network` does not reliably serve older historical state at heights such as `25573978` and `25573977`; `thornode-archive.ninerealms.com` is required for historical bond-history reconstruction.
- Most deleted all-zero `bond_history` rows were not recoverable missing rewards; they represented genuine zero-bond periods and should remain absent.
- The original repair process only emitted a final summary and buffered writes until completion, which made it appear hung even while progressing.
- Midgard completeness differences between `midgard.thorchain.network` and `midgard.ninerealms.com` are real but intermittent; fallback behavior is still warranted, but Nine Realms should not be treated as the default source of truth.

## Files Changed

| File | Change |
|------|--------|
| backend/src/handlers/bond-history.js | Hardened historical fetch handling, poison-row filtering, and backfill stop behavior |
| backend/src/shared/bond-history.js | Added shared bond-history row computation and poison-row helpers |
| backend/src/shared/thornode.js | Added archive-aware historical THORNode fallback logic |
| backend/src/shared/midgard.js | Added resilient Midgard fetch helpers with fallback validation |
| backend/src/jobs/rapid-swaps-scheduler.js | Improved rapid-swap scheduler prioritization and processing |
| backend/src/shared/rapid-swap-candidates.js | Added pending-candidate merge/prioritization utilities |
| backend/src/lib/config.js | Updated endpoint defaults to prefer official THORChain origins |
| backend/migrations/009_rapid_swap_candidate_priority.sql | Added DB index/supporting migration for rapid-swap candidate priority |
| scripts/repair-bond-history.mjs | Added logged, incremental bond-history repair/backfill script |
| scripts/deploy-boonetools-backend.sh | Ensured live backend `.env` is rewritten with current endpoint settings and new repair script ships |
| src/lib/BondTrackerV2.svelte | Moved bond-history Midgard action fetches onto the shared client with paging/fallback |
| src/lib/api/thornode.js | Updated frontend THORNode provider strategy to prefer official + archive-aware fallback |
| src/lib/node-operator/api.js | Updated Node Operator helper fallback strategy for historical requests |
| src/lib/utils/api.js | Replaced old fallback endpoints with Nine Realms fallbacks |
| src/lib/api/index.js | Updated exported endpoint references to match the new provider model |
| src/lib/rapid-swaps/backend.js | Hardened rapid-swap Midgard paging/catch-up logic and provider ordering |
| src/lib/rapid-swaps/reconciliation.js | Tightened rapid-swap reconciliation matching rules |
| backend/tests/bond-history.test.js | Added coverage for bond-history row calculation and poison-row helpers |
| backend/tests/midgard.test.js | Added backend Midgard fallback coverage |
| backend/tests/rapid-swaps-scheduler.test.js | Added rapid-swap scheduler priority/merge coverage |
| backend/tests/thornode.test.js | Added archive fallback coverage for historical THORNode requests |
| tests/bond-tracker-midgard.test.js | Added frontend Midgard fallback coverage for bond tracker |
| tests/rapid-swaps-backend.test.js | Added rapid-swap catch-up regression coverage |
| tests/rapid-swaps-reconciliation.test.js | Added reconciliation plausibility and scoring regression coverage |

## In Progress

Unrelated local edits remain in `src/lib/LimitOrders.svelte` and `src/lib/components/ConnectWallet.svelte`. They were intentionally excluded from this session commit and deploy.

## Next Steps

- [ ] Monitor live rapid-swap ingestion and bond-history responses after the endpoint preference rollout.
- [ ] Re-check `midgard.thorchain.network` intermittency and reduce fallback scope if the official proxy stabilizes.
- [ ] Use `scripts/repair-bond-history.mjs` for any future targeted bond-history repair instead of ad hoc temp scripts.
- [ ] Handle the unrelated `LimitOrders` / `ConnectWallet` work in a separate session or commit.
