# NEAR revenue reconciliation — September 20, 2026

Read-only financial investigation; no collector, methodology, or production
changes. Public responses checked around 18:13 UTC. BooneTools snapshot:
`2026-09-20T14:08:14.107Z`, through September 19. This investigation supersedes
any assumption that the wallet-receipt proxy reconciles with NEAR's monthly
reported revenue. It does not establish that either is audited profit.

## Monthly comparison

USD, rounded to whole dollars. Positive difference means NEAR reports more.

| Month | BooneTools swap income | NEAR monthly revenue | NEAR minus BooneTools |
| --- | ---: | ---: | ---: |
| January 2026 | 359,240 | 534,276 | +175,036 |
| February | 663,127 | 427,549 | -235,578 |
| March | 563,460 | 396,060 | -167,400 |
| April | 258,740 | 349,538 | +90,798 |
| May | 619,614 | 743,531 | +123,917 |
| June | 619,475 | 784,558 | +165,083 |
| July | 504,864 | 690,183 | +185,319 |
| August | 723,262 | 1,001,273 | +278,011 |
| January–August | 4,311,782 | 4,926,968 | +615,186 |
| September, displayed month-to-date* | 942,967 | 1,437,537 | +494,570 |

January–August BooneTools is 12.4861% below NEAR's reported total. August is
approximately 27.8% below. February and March are higher, so an always-positive
missing fee category cannot by itself explain the full historical difference.

*Both sites' daily series end September 19. The official monthly endpoint's
envelope/cutoff is not retained in its public HTML, so exact September monthly
cutoff equivalence is not independently established. Use complete months for
the decisive comparison. The official monthly rows through June carry
`is_stale: 1`; July–September carry `0`. This is a provenance qualification,
not proof that the older numbers are false.

## Verified identities

Live diagnostic assertions passed for every complete month January–August:

1. BooneTools published `incomeUsd` equals the monthly sum of DeFiLlama
   `dailyRevenue`, within $0.001.
2. The locally saved, fully paginated FastNear wallet receipts equal the sum
   of NEAR's own daily `intents_revenue_near`, within 0.000001 NEAR. Both
   datasets contain the correct number of calendar days for each month.

In August, both receipt series contain **405,386.3307645831 NEAR**. The separate
official monthly revenue series contains **561,423.6923341962 NEAR**. Thus the
discrepancy is present before dollar conversion, not just a price-feed issue.

Our daily collector includes all three revenue wallets, including the
proprietary frontend. Its `Other` receipt category already bundles non-frontend
sources. Do not add a named official stream on top without proving that it is
absent from the receipts; that would risk double counting.

NEAR's six official revenue streams are Front-end, Quote Improvement,
Authorized partner, Private agreement, Other, and Unauthorized partner.
Their all-time USD sum, **$7,604,766.262393478**, exactly equals the sum of the
official monthly revenue series. Their wallet table is a separate metric.
The public frontend does not expose the backend transaction-to-stream ledger.
Different earning/sweep dates and classification remain explanations to test,
not proven explanations for the entire residual.

### Could other NEAR services explain it?

Possible in part, but unproven. The official data guide describes the named
streams as Intents frontend, quote improvement and partner/private-agreement
capture, and describes its separate offchain-revenue endpoint as empty/not
yet available. This is documentation, not a successful live read of that
authenticated endpoint. The frontend does not explain the `Other` category;
it must not be assumed to mean unrelated NEAR services. No explicit AI-cloud,
Rhea, or other-service allocation was established in this investigation.
Other apps' earnings are not automatically NEAR-protocol receipts.

## Other differences

- **L1 fees:** Our requested swap-income boundary excludes general NEAR gas
  fees. The official daily data separately contains `protocol_fee_near`.
  Its modeled burn component is `burn_revenue_near - intents_revenue_near`
  (70% of the protocol-fee field in the observed data). In August this is
  **20,974.4114138186 NEAR**, approximately **$36,538** using our saved daily
  prices. This is much smaller than the $278,011 monthly revenue gap. It is
  not automatically additional swap income; a whole-network net-issuance
  comparison would need a consistent, separate burn treatment.
- **Emissions:** Our live subsidy is still the labeled official-dashboard
  model, pending full exact-chain backfill. In August we value it at
  **$4,790,771.711937094**. Their displayed 20.81% revenue/issuance ratio and
  $1,001,273 revenue imply approximately $4.81m of issuance (rounded ratio).
  Their frontend uses monthly average prices; ours values daily issuance.
  There is no evidence here of a several-fold issuance error.
- **Sensitivity, not a deployed correction:** Replacing only August income
  with their reported number would change our result from **-$4,067,510** to
  **-$3,789,498**, keeping our existing subsidy. Their own reported revenue
  covers only 20.81% of August issuance, so higher income does not reverse
  the sign under the chosen 100%-of-network-issuance allocation.
- **Buybacks:** Spending captured revenue on buybacks is not a second revenue
  stream to add on top of that revenue. A supply metric must distinguish
  actual burns from purchases/holdings/locking.
- **2025 gaps:** BooneTools' missing September–December net bars are caused
  by incomplete issuance coverage, not an assertion of zero income.
- **Operating subsidies:** This reconciliation does not quantify unrecovered
  TRON energy or stablecoin incentives. Neither a wallet inflow nor the
  official phrase net revenue proves all operating expenses were deducted.

## Sources and reproduction

- [BooneTools production response](https://boone.tools/functions/v1/protocol-fee-comparison)
- [NEAR public dashboard](https://revenue.near.org/)
- [DeFiLlama daily revenue](https://api.llama.fi/summary/fees/near-intents?dataType=dailyRevenue)
- [DeFiLlama adapter](https://github.com/DefiLlama/dimension-adapters/blob/master/fees/near-intents/index.ts)
- [Official frontend API client](https://github.com/near/near-revenue-dashboard/blob/main/src/lib/api.ts)
- [Official frontend price/issuance derivation](https://github.com/near/near-revenue-dashboard/blob/main/src/lib/utils.ts)
- [Official data guide source](https://github.com/near/near-revenue-dashboard/blob/main/src/app/data/page.tsx)

Decode JSON string chunks inside the public page's `self.__next_f.push`
records without executing scripts. Inspect component props containing raw
`revenueSeries` (`period_month`, `revenue_usd`, `revenue_near`),
`totalFeesSeries`, `streams`, and `absoluteRevEmissions`. Aggregate daily rows
by UTC calendar month and compare to production `months[].protocols.near`.
The historical local receipt/price source is the canonical checkout's
`node_modules/.cache/protocol-fee-comparison/state.json`, under `.cache.days`.
Its September stops on the 18th, so it was used only for complete-month
assertions, not represented as current production data.

The directly documented official API endpoint returned HTTP 401 without an
API key. No key was sought and no authentication bypass was attempted. The
public HTML nevertheless exposes the monthly and daily datasets above.

## Required next accounting decision

The original September 18 report already warned that the cash-receipt proxy
did not reconcile with NEAR's reported streams. That uncertainty needs to
remain explicit in the product. Do not infer a specific missing stream from
the residual. Reconcile transaction timing, retained shares, valuation and
source coverage, or present NEAR-reported revenue and independently observed
cash receipts as distinct labeled measurements. Do not blend the two or
silently change only selected months.
