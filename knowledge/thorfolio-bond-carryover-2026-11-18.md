# Thorfolio bond yield: exclude prior-churn carryover

## Observed issue

The November 18 churn at height 28,722,159 left approximately 633,548.54
RUNE in the network bond reward pool after payouts. Immediately before churn,
the pool held 3,346,687.19 RUNE and summed active-node current awards were
2,713,139.44 RUNE. Slash-point reward deductions leave undistributed rewards
in the pool; this is distinct from confiscated bond principal.

At height 28,731,850, the pool held 764,124.95 RUNE: approximately 82.91%
was carried over. Thorfolio annualized the full pending award across only
16.46 hours since churn. For bond provider ending 7j9y, the 22,199.63 RUNE
bond and 141.66 RUNE pending award implied about 340% APR / 2,835% APY.
Removing the carryover component yielded approximately 58% APR / 79% APY
at that snapshot, still a short-period estimate rather than a forecast.

## Intended calculation

For current projected APR/APY only, multiply each provider's net pending
award by `(current pool - post-churn pool) / current pool`. The operator
fee and current slash-point adjustments already embedded in the pending
award apply equally to both components. Keep the entire pending award visible
and leave completed-churn realized history unchanged.

Use the post-payout pool at the last churn block as the baseline, cache it
by verified block height, and never reuse it for a different churn. Unknown
or inconsistent baseline data means unavailable yield, not unadjusted yield
or a manufactured zero. The churn block's own newly accrued reward is also
excluded by this conservative block-end baseline.

Historical REST state must not be accepted merely because the request has a
height parameter. See `bond-tracker-apy-investigation-2026-09-20.md`: provider
responses have ignored requested heights. Verify the actual response height.

## Scope

Thorfolio's current projected yield only; no wallet transactions, reward
payout changes, production-history rewrites, or historical data backfill.

## Implementation and verification

Thorfolio now uses verified, same-height node/network/vault observations.
Historical REST responses must expose the exact requested Cosmos block-height
header before a baseline is cached; active vault status heights must agree
with the churn clock. Failed baseline reads retry on the next refresh.
Missing or inconsistent evidence produces unavailable projected yield while
retaining pending rewards and balances.

A live run of the actual calculation modules at height 28,732,248 returned
22,199.6321499 RUNE bonded, 142.69591193 RUNE pending, 58.0330% APR and
78.5805% APY for provider ending 7j9y. The post-churn baseline was independently
confirmed by an exact-height RPC Network query (protobuf field 1).

The original failing carryover test now passes; all 841 frontend tests pass.
Browser verification was unavailable because the automation native pipe was
missing. This change is local and has not been committed or deployed.
