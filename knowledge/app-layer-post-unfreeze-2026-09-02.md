# App Layer revenue after the Wasm unfreeze

Observed on 2026-09-02 around 04:30–04:40 UTC (just after midnight EDT).

## Production findings

- The public network snapshot reports `HALTWASMGLOBAL=0` and
  `HALTWASMCONTRACT=0`.
- `/functions/v1/app-layer-base-fees` is current. Its September 1 UTC bucket
  reports 984.41986474 RUNE / $474.30571227 in generated THORChain liquidity
  fees; September 2 already has additional events. These fees come from a
  separate swap-event ingestion lane.
- `/functions/v1/app-layer-base-layer-earnings` is stale. Its last stored day
  is August 26, with snapshot time `2026-08-26T23:58:13.818Z`. It does not
  establish zero app earnings after that date.
- `/functions/v1/app-layer-live-state` is current with no route failures.
  Base Layer collector `...dktr` holds 17,572.22575771 RUNE, and its contract
  `last_executed` remains `2026-08-26T00:04:05.788Z`.
- The explicit Reserve/POL settlement ledger last paid at height 27580136,
  `2026-08-26T00:04:06Z`. This agrees with the current contract state.
- Liquify `/schedules?sender=<collector>&pagination.limit=10` returned no
  schedules for all five dashboard collectors: Trade `...pus7`, Core
  `...5c0y`, Swap `...ccew`, Index `...764l`, and Base `...dktr`.
  The production Reserve scanner independently records
  `THORNode returned no active Base Layer revenue schedule`, while using
  its previous schedule anchor for historical scanning.

## Earnings ingestion defect

`estimateHeightAt` in `backend/src/shared/rujira-base-layer-earnings.js`
extrapolated from the nearest Reserve payout at six seconds per block before
checking actual RPC timestamps. With payouts stopped and block production
slower, September 2 midnight extrapolated from height 27580136 to **27680895**,
above the observed current chain head **27656344**. RPC rejected the request.
The last persisted midnight baseline is August 26, so every later refresh
needs the failing lookup.

The failure was reproduced against production using a read-only database
session and locally through the public earnings refresh function with mocked
RPC/bank responses. The regression is
`backend/tests/rujira-earnings-halted-chain.test.js`.

The live-state scheduler catches earnings errors and returns an
`earnings_warning`; the generic job entry point discards the result and logs
completion. Thus successful live-state job exits do not demonstrate healthy
earnings acquisition. Public earnings metadata correctly remains stale.

## Collector execution is a separate recovery task

The local THORNode scheduler implementation removes a due schedule even when
contract execution fails (`x/scheduler/keeper/keeper.go`). The Rujira revenue
contract enqueues its next run only during successful distribution
(`contracts/rujira-revenue/src/contract.rs`). A failed scheduled execution can
therefore end the recurring sequence; clearing the Wasm halt alone does not
recreate it. This is consistent with the missing live schedules, but the exact
transaction or error that removed each schedule was not traced here.

The configured executor or appropriate contract administrator must restore
collector execution. BooneTools can repair its earnings acquisition, but that
does not cause on-chain Reserve or POL payments.

## Scope and remaining work

The local lookup fix uses adjacent persisted headers, otherwise bounded RPC
timestamp search, to find the last confirmed block before midnight. It stores
the actual block timestamp and rejects unverifiable coverage without replacing
historical balances with current balances. All 14 focused earnings/live-state
tests pass, including the original future-height regression, a halt across
midnight, missing timestamps, and pruned history; `git diff --check` passes.

Production deployment and reconstruction of missing August 27–September 1
daily earnings remain separate from this investigation. The existing live
refresh only writes its observed UTC day; changing the lookup alone does not
recreate all missed daily inventory snapshots. Do not fill those gaps with
zeroes or allocate their combined change to the recovery day.

No production data, deployment, or on-chain state was changed during this
investigation.
