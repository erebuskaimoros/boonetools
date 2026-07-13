# Rujira Base Layer Fee-Share Chart

This standalone artifact tracks observed final reserve deposits from the Rujira Base Layer revenue collector.

## Mechanism

The Rujira repo uses the generic `rujira-revenue` contract to route collected revenue. Current on-chain collector configs show:

- RUJI Trade and Other Core Apps allocate eligible target-denom distributions 1:1 between the RUJI Swap collector and the Base Layer collector. RUJI Index routes its eligible target denoms to the RUJI Swap collector.
- The Base Layer collector is `thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr`.
- That collector targets `rune` and sends only RUNE, subject to its configured rate limit, to the THORChain reserve module with `/types.MsgDeposit` and memo `RESERVE`.
- A target address is an allocation for its configured target denoms, not proof that every balance held by a collector is transferable. Non-target inventory needs a configured conversion action or remains stranded.
- The collector contract itself was created at THORChain height `21359953` on 2025-06-02. The currently observed final reserve-deposit events in this artifact start on 2026-04-30, so this should be read as the final Base Layer payment path, not proof of all historical Rujira revenue accrual.

## Data

`scripts/rujira-base-layer-fees.mjs`:

1. Reads the Base Layer collector config from THORNode.
2. Fetches its `wasm-rujira-revenue/run` actions from Midgard.
3. Scans the collector's scheduler cadence through its live `last_executed` height for explicit `reserve` finalize-block events.
4. Aggregates reserve deposits by UTC week.
5. Converts weekly RUNE to USD using Midgard weekly RUNE/USD history.

## Outputs

- `rujira-base-layer-fees.html`: standalone chart and table.
- `rujira-base-layer-fees.svg`: chart image.
- `rujira-base-layer-fees.csv`: weekly source table.
- `rujira-base-layer-fees-events.json`: raw reserve deposit events used.
- `rujira-base-layer-fees-meta.json`: source/config metadata.

## Scope

This static artifact is a dated fallback. It confirms explicit `RESERVE` deposits on the scheduler cadence, but it is not a live API ledger and its weekly price basis may differ from the API's per-event historical pricing. Collector-distribution context is intentionally not a dashboard revenue total: direct distributions and point-in-time balances are separate, non-additive observations.

## 01 app-layer earnings artifact

`scripts/rujira-base-layer-inflows.mjs` generates the separate daily/weekly 01
accrual series. Its accounting boundary contains the current configured Base
Layer share of every routable balance on the path: 50% of RUJI Trade, 50% of
Other Core Apps, and 100% of the Base Layer Collector. Swap and Index are
excluded because their configured targets do not route to the Base Layer.

Each period records newly earned value. Transfers within the boundary and
final Reserve payouts cancel rather than create new earnings. The cumulative
view is an optional rollup of those period rows and overlaps 02; it is never
added to the Reserve-payment total.
