# Rujira Base Layer Fee-Share Chart

This standalone artifact tracks observed final reserve deposits from the Rujira Base Layer revenue collector.

## Mechanism

The Rujira repo uses the generic `rujira-revenue` contract to route collected revenue. Current on-chain collector configs show:

- RUJI Trade and Other Core Apps split revenue 1:1 between the RUJI-staker collector and the Base Layer collector.
- The Base Layer collector is `thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr`.
- That collector targets `rune` and sends payments to the THORChain reserve module with `/types.MsgDeposit` and memo `RESERVE`.
- The collector contract itself was created at THORChain height `21359953` on 2025-06-02. The currently observed final reserve-deposit events in this artifact start on 2026-04-30, so this should be read as the final Base Layer payment path, not proof of all historical Rujira revenue accrual.

## Data

`scripts/rujira-base-layer-fees.mjs`:

1. Reads the Base Layer collector config from THORNode.
2. Fetches its `wasm-rujira-revenue/run` actions from Midgard.
3. Reads each action height's `reserve` finalize-block event from Tendermint RPC.
4. Aggregates reserve deposits by UTC week.
5. Converts weekly RUNE to USD using Midgard weekly RUNE/USD history.

## Outputs

- `rujira-base-layer-fees.html`: standalone chart and table.
- `rujira-base-layer-fees.svg`: chart image.
- `rujira-base-layer-fees.csv`: weekly source table.
- `rujira-base-layer-fees-events.json`: raw reserve deposit events used.
- `rujira-base-layer-fees-meta.json`: source/config metadata.
