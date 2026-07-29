# Wasm Arb Economics Dashboard

## Purpose

`/wasm-arb-economics` tracks whether changes to `WasmArbSlipMinBps` improve
observable THORChain economics. It keeps the accounting question explicit:
did THORChain's attributable cash flow improve, and did it improve per unit of
THORChain network volume?

The page is backed by the provider-free `/functions/v1/wasm-arb-economics`
read model. A five-minute job ingests new chain data, records Mimir and Trade
Collector allocation regimes, and republishes the compact dashboard payload.

## Canonical metrics

- Network volume is Midgard executed-leg swap volume. Cross-asset routes count
  both pool legs; route notional is not used as the fee denominator.
- Wasm volume is the executed-leg volume of Midgard actions involving the
  tracked Wasm arb contract. Wasm share is Wasm leg volume divided by network
  leg volume for the same complete buckets.
- THOR LP fees are the Wasm actions' Midgard `liquidityFee` values, converted
  from RUNE base units with the corresponding historical RUNE/USD bucket.
- All Rujira fees are actual bank transfers into the RUJI Trade collector from
  every live FIN code-ID-180 contract plus the tracked Wasm AMM contract.
- Linked Rujira fees are the subset whose fee transfer occurs in the same
  transaction as an execution of the tracked Wasm contract. FIN range fees are
  reported as a subset of FIN, not added on top of FIN.
- THORChain linked value is Wasm THOR LP fees plus the configured THORChain
  share of Wasm-linked Rujira fees. A broader context line applies the share to
  all eligible FIN and AMM fees, but it is not labeled Wasm-attributable.
- Value density is THORChain linked value per $1 million of total THORChain
  executed-leg volume.
- Break-even compares the post-change linked Rujira lift allocated to
  THORChain with the observed loss in Wasm THOR LP fees. Gross Rujira
  break-even is `LP fee loss / THORChain collector share`.

## Attribution and discovery

The collector-fee lane needs transaction identity, so it intentionally uses
event-sum accounting rather than collector balance deltas. Live contract
metadata enumerates all FIN code-ID-180 senders; the AMM contract is fixed.
Cosmos indexed transaction search for `transfer.recipient` finds candidate
heights, and canonical `block_results` events supply the transfer amounts and
transaction-local linkage. This avoids the blind spot in Midgard action
address filters, which do not discover every internal FIN transfer.

Asset fees use historical bucket prices: RUNE history for RUNE, parity for
recognized stablecoins, and Midgard depth history for other denoms. Missing
prices remain explicit coverage gaps and prevent a definitive verdict.

## Comparison rules

- Compare equal-duration complete windows on either side of a Mimir regime
  boundary.
- Exclude the five-minute bucket containing the change; do not allocate a
  transition bucket to either regime.
- The `SINCE CHANGE` view expands only when equal complete history exists on
  both sides. Fixed 6h, 24h, 3d, and 7d views use the same rule.
- Preserve the 14-day pre/post activation archive alongside the rolling
  30-day dataset so the original intervention remains reviewable later.
- Keep a result provisional while network, action, collector-transfer, block,
  or price coverage is incomplete.

The verdict is an observed cash-flow comparison, not causal proof. Market mix,
volatility, pool depth, RUNE price, competing arbitrageurs, and later Mimir or
collector-allocation changes can all move the same metrics.

## Production components

- Migration: `backend/migrations/031_wasm_arb_economics.sql`
- Ingestion: `backend/src/shared/wasm-arb-economics-ingestion.js`
- Read model: `backend/src/shared/wasm-arb-economics.js`
- Scheduler: `backend/src/jobs/wasm-arb-economics-scheduler.js`
- Frontend: `src/lib/WasmArbEconomics.svelte`
- Service timer: `ops/systemd/boonetools-wasm-arb-economics.timer`
