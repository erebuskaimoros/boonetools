# Wasm Arb Economics Dashboard

## Purpose

`/wasm-arb-economics` tracks whether `WasmArbSlipMinBps`, arb-contract
`spread_bps`, and later allocation changes improve observable THORChain
economics. It keeps the accounting question explicit:
did THORChain's attributable cash flow improve, and did it improve per unit of
THORChain network volume?

The page is backed by the provider-free `/functions/v1/wasm-arb-economics`
read model. A five-minute job ingests new chain data, records Mimir,
`spread_bps`, and Trade Collector allocation regimes, and republishes the
compact dashboard payload.

## Canonical metrics

- Network volume is Midgard executed-leg swap volume. Cross-asset routes count
  both pool legs; route notional is not used as the fee denominator.
- Wasm volume is the executed-leg volume of Midgard actions involving the
  tracked Wasm arb contract. Wasm share is Wasm leg volume divided by network
  leg volume for the same complete buckets. Identical duplicate outbound
  records inside one action are collapsed before output-leg valuation.
- THOR LP fees are the Wasm actions' Midgard `liquidityFee` values, converted
  from RUNE base units with the corresponding historical RUNE/USD bucket.
- All Rujira fees are actual bank transfers into the RUJI Trade collector from
  every live FIN code-ID-180 contract plus the tracked Wasm AMM contract. This
  includes transaction and finalize-block fee transfers.
- Linked Rujira fees are the subset whose fee transfer occurs in the same
  transaction as an execution of the tracked Wasm contract. FIN range fees are
  reported as a subset of FIN, not added on top of FIN.
- THORChain linked value is Wasm THOR LP fees plus the configured THORChain
  share of Wasm-linked Rujira fees. A broader context line applies the share to
  all eligible FIN and AMM fees, but it is not labeled Wasm-attributable.
- Value density is THORChain linked value per $1 million of total THORChain
  executed-leg volume. Linked and broad value per $1 million of Wasm
  executed-leg volume are also reported.
- Break-even compares the post-change linked Rujira lift allocated to
  THORChain with the observed loss in Wasm THOR LP fees. Gross Rujira
  break-even is `LP fee loss / THORChain collector share`.

## Attribution and discovery

The collector-fee lane needs transaction identity, so it intentionally uses
event-sum accounting rather than collector balance deltas. Live contract
metadata enumerates all FIN code-ID-180 senders and persists their base/quote
denoms; the AMM contract is fixed. Tendermint `tx_search` and `block_search`
independently find transaction and finalize-block candidate heights, and
canonical `block_results` supplies amounts and transaction-local linkage. This
avoids both the ignored Cosmos REST offset that repeated the first page and the
blind spot in Midgard action address filters.

Asset fees use historical bucket prices: RUNE history for RUNE, parity for
recognized stablecoins, and Midgard depth history for other denoms. If a FIN
fee denom has no direct historical pool price, the same transaction's FIN
trade event supplies an execution-rate cross through its priced counterpart.
Missing prices remain explicit coverage gaps and prevent a definitive verdict.

Pool-price quality is a separate, non-cash lane. The job samples the 12
comparable Wasm-path pools and THORChain oracle at the same historical block,
then reports signed, absolute, depth-weighted, within-10/25-bps, maximum-tail,
and LTC-excluded deviation. Global backfill completion is not enough: both
selected windows must contain sampled buckets throughout.

## Comparison rules

- Compare equal-duration complete windows on either side of a selected Mimir
  or `spread_bps` intervention boundary.
- Exclude the five-minute bucket containing the change; do not allocate a
  transition bucket to either regime.
- The `SINCE CHANGE` view expands only when equal complete history exists on
  both sides. Fixed 6h, 24h, 3d, and 7d views use the same rule.
- Preserve the 14-day pre/post activation archive alongside the rolling
  30-day dataset so the original intervention remains reviewable later.
- Keep a result provisional while network, action, collector-transfer, block,
  or price coverage is incomplete.

The corrected 29h25m-per-side Mimir regression fixture is intentionally exact:
strict THORChain linked value is `$215.406510` before and `$181.838045` after
(`-$33.568465`, `-15.58%`); broad value is `$228.817660` and `$193.385720`;
strict value per $1m of network volume is `$13.0527` and `$9.0381`; strict
value per $1m of Wasm volume is `$1,793.11` and `$816.43`. These values catch
the duplicate-outbound error and incomplete FIN accounting while retaining FIN
range as a subset.

The verdict is an observed cash-flow comparison, not causal proof. Market mix,
volatility, pool depth, RUNE price, competing arbitrageurs, and later Mimir or
collector-allocation changes can all move the same metrics.

## Production components

- Migrations: `backend/migrations/031_wasm_arb_economics.sql` and
  `backend/migrations/032_wasm_arb_economics_accounting.sql`
- Ingestion: `backend/src/shared/wasm-arb-economics-ingestion.js`
- Read model: `backend/src/shared/wasm-arb-economics.js`
- Scheduler: `backend/src/jobs/wasm-arb-economics-scheduler.js`
- Frontend: `src/lib/WasmArbEconomics.svelte`
- Service timer: `ops/systemd/boonetools-wasm-arb-economics.timer`

Migration 032 invalidates prior dashboard read models and clears only derived
action/block/fee caches. Corrected actions, fee events, and completed block
scans carry accounting version 2, so a rollback cannot make version-1 rows look
complete. Production shows `SYNCING` until canonical sources repopulate the
corrected v2 model instead of mixing old and new accounting.
