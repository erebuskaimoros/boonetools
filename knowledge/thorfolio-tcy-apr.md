# Thorfolio TCY payout APR

## Incorrect upstream annualization (2026-10-21)

Thorfolio initially displayed Midgard's `/v2/tcy/distribution/{address}` `apr`
field directly. Liquify returned approximately 8.63% for provider …hxff and
70.11% for provider …pqx8, despite the same rewards per staked TCY.

The cause is visible in Midgard commit
[`4c2b2b0`](https://gitlab.com/thorchain/midgard/-/blob/4c2b2b0c5c8007e50268aa6c3a4ce99efc4051e8/internal/timeseries/stat/tcy.go):
`GetTCYDistribution` groups payout events without an `ORDER BY`, then treats
`distributionItems[0]` as the first payout. If that item falls within the
requested period, it shortens the annualization window to that timestamp,
while retaining all rewards from the original period. The default period is
30 days, set by `jsonTCYDistribution` in `internal/api/json.go`.

For provider …pqx8, the first returned event was October 17, 2026, about 3.7
days before the observation, while its oldest payout was June 14, 2025.
Annualizing the full 30-day rewards over 3.7 days explains the roughly eightfold
inflation. Provider …hxff happened to have an older event first and avoided
the shortened denominator. Sorting the displayed rows after receiving the
response cannot repair an already calculated upstream APR.

The two addresses each had 29 payouts in the trailing 30 days:

| Provider | Current staked TCY | RUNE paid in 30 days | RUNE per staked TCY |
|---|---:|---:|---:|
| …hxff | 305,913.84647258 | 593.47286211 | 0.00194 |
| …pqx8 | 5,357.96938623 | 10.39446061 | 0.00194 |

## Display contract

Thorfolio derives **30d payout APR** independently:

`RUNE paid in the trailing 30 days × current RUNE price / (current staked TCY × current TCY price) × 365 / 30 × 100`

The window uses actual timestamps and remains 30 days regardless of array
order, event count, or the first payout. Future events are excluded. It is a
backward-looking payout ratio at current prices, not a time-weighted personal
return or a forecast. Stake changes during the window affect this ratio.

At the investigation's current pool prices, both addresses gave about 9.76%.
This differs from the corrected upstream figure of about 8.63% because Midgard
uses an average historical TCY/RUNE pool price for its denominator.

Missing payout data or unusable stake/price inputs must remain unavailable;
an explicit empty payout list with valid stake/prices is a known zero. Portfolio
aggregation must disclose unavailable APR data rather than convert it to zero.

Regression coverage is in `tests/thorfolio-tcy-apr.test.js`. The original
reproduction failed before implementation: proportional payout histories
in different orders inherited distinct upstream APR values.

## Daily payout chart

Daily payout bars are paired with an amber **Total paid out** line. Accumulate
all available payout history for the selected addresses before applying the
chart's date filter, so the line retains payouts from before the visible domain
and ends at the same total as the payouts-received card. RUNE and historical
payout values accumulate independently; current display currency applies to
the value series through the existing money formatter.

The cumulative right axis fits the visible values with 5% padding; daily bars
retain a zero baseline on the left axis. Both axes update when the domain or
unit changes. `tests/thorfolio-tcy-cumulative.test.js` covers lifetime carry-in,
address filtering, unordered input, historical value totals, and immutability.

## Unavailable balances

A failed TCY-staker request is unavailable, not a zero stake. The loader validates
base-unit amounts and only treats the explicit `TCYStaker doesn't exist` protocol
error as a known absence. The development proxy preserves this protocol detail.
Failed bank reads likewise leave liquid TCY unavailable. Unknown positions remain
visible even without payout history, and portfolio/address totals are marked partial.
Any unknown stake makes the combined APR unavailable; known payout history remains
visible. Regression tests cover failures, malformed responses, known zeroes and
refresh recovery in `tests/thorfolio-tcy-availability.test.js`.
