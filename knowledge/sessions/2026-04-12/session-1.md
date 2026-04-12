# Session 1 - Bond Tracker Zero-Row Cleanup for thor1fkd9...

> Date: 2026-04-12
> Focus: Investigate false recent bond/unbond activity for `thor1fkd9rm6fkehrk3phupq7c2vsef0xqv448j7j9y` and clean bad bond-history rows

## Summary

Investigated the Bond Tracker history for `thor1fkd9rm6fkehrk3phupq7c2vsef0xqv448j7j9y` after the table appeared to show recent bond/unbond activity that should not exist. The root cause was bad all-zero `bond_history` rows in the live database; I deployed a backend fix to stop serving/storing those rows, removed `2,131` such rows live, and verified the wallet’s recent history returned to a normal nonzero sequence.

## Work Done

- Queried the live `bond-history` API and Midgard bond-action feed for `thor1fkd9rm6fkehrk3phupq7c2vsef0xqv448j7j9y`.
- Confirmed Midgard had no recent bond actions for that wallet in the current churn range.
- Found a bogus zero-value `bond_history` row at churn `25623871` for the wallet, which produced a fake recent unbond/rebond pattern.
- Generalized the backend poison-row rule so any row with `rune_stack = 0` and `user_bond = 0` is treated as invalid history regardless of `rune_price`.
- Updated the bond-history handler so zero-value computed rows are skipped instead of being inserted.
- Ran backend tests, redeployed the Hetzner backend, backed up the zero rows on the server, and deleted `2,131` all-zero `bond_history` rows from the live DB.
- Re-verified the wallet history after cleanup and confirmed the current table looked acceptable, so no additional UI logic changes were kept.

## Discoveries

- The bad tracker behavior for this wallet was caused by stored zero-value `bond_history` rows, not by recent real bond transactions.
- For this wallet, the newest Midgard bond action is still from December 2025, so any recent bond/unbond display was necessarily synthetic.
- Rows with `rune_stack = 0` and `user_bond = 0` are unsafe to keep even when `rune_price` is nonzero; they still corrupt churn-to-churn delta interpretation.
- After removing the bogus zero row, the remaining recent principal drift for this wallet was tiny, on the order of fractions of a RUNE, not large bond events.

## Files Changed

| File | Change |
|------|--------|
| backend/src/shared/bond-history.js | Treat any zero-value bond-history row as poisoned/invalid |
| backend/src/handlers/bond-history.js | Skip storing zero-value churn rows during history backfill |
| backend/tests/bond-history.test.js | Added coverage for nonzero-price zero rows being treated as poisoned |

## In Progress

None - session complete. Unrelated local edits remain in `src/lib/LimitOrders.svelte` and `src/lib/components/ConnectWallet.svelte` and were intentionally excluded.

## Next Steps

- [ ] Monitor the live Bond Tracker for other wallets that previously showed suspicious recent bond/unbond activity.
- [ ] If the issue resurfaces, inspect the remaining principal drift separately from bond tx matching before changing the UI.
- [ ] Consider adding a future `adjustment/slash` interpretation only if a real wallet needs that extra breakdown.
