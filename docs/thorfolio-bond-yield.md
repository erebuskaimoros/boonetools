# Thorfolio Bond Yield management

Thorfolio's Bond tab supports the THORNode 3.21 payout configuration in each
node row's **payout** action. The table reads `bps` and `payout_target` from
each bond provider. These are preferences for future reward distributions;
they are not a withdrawable balance.

## Configuration

- Enter 0–100%, with up to two decimal places. Zero turns payouts off and clears
  the saved target; the rest of the provider's future reward is rebonded.
- Choose the provider wallet for native RUNE, or a mainnet THOR address / owned
  THORName. Provider-wallet mode explicitly includes the provider address in
  the memo, so switching back from a custom target cannot accidentally retain it.
- A non-zero memo with no target preserves the chain's stored target. This is
  supported by the plan builder but not exposed as an ambiguous blank form input.
- THORName routes are resolved during review. Names require current provider
  ownership; names with a preferred asset use the affiliate collector. Otherwise
  the THOR alias (or owner) receives RUNE.
- Plans use `BONDYIELD:<node>:<bps>[:<target>]`, `THOR.RUNE`, zero amount and the
  existing wallet `MsgDeposit` path. A normal network fee still applies.

## Activation and transaction review

Signing requires a stable current network version at least 3.21 and an effective
positive `BondYieldEnabled` value. Explicit Mimir overrides take precedence over
compiled constants; missing or failed reads block the new action. `next` and
`querier` versions do not establish network activation.

The connected signer must match the selected provider. Only Active, Standby and
Ready nodes qualify, and fresh node state must still list that provider. The
**check payout settings** step checks these constraints and resolves the target.
Any change to the memo or signer invalidates that review. Signing repeats the
network, membership and destination checks before opening the wallet; a changed
THORName resolution or failed check stops the operation.

The checks use the shared THORNode client with `cache: false` and
`coreSnapshot: false`. Manual / post-transaction portfolio refreshes also read
current node state directly so newly observed settings are not hidden by a
dashboard snapshot. Initial page loading continues to reuse the core snapshot.
No new backend read model or migration is required for the configuration fields.

## Scope and validation

This change manages payout preferences. It does not add a separate payout-history
ledger. Existing APY is a full-reinvestment projection, now explicit in the
summary tooltip. Any future payout accounting should use `bond_yield` events
without counting their paired `bond_returned` transfer twice.

On October 21, 2026, the public Liquify `/thorchain/version` response reported
current 3.20.3. The browser correctly displayed the 3.21 prerequisite. No wallet
was connected or transaction broadcast during validation. Live signing and
post-activation settlement remain release checks.

Focused coverage: `tests/position-tracker-bond-yield.test.js` checks memo precision,
checksums and input rejection, provider state mapping, version/Mimir precedence,
ownership and node status, THORName routes, stale-review rejection, direct reads,
and the final pre-signing check. The existing Thorfolio suites cover the surrounding
bond and address controls.

## Protocol sources

- [THORNode v3.21.0 handler](https://gitlab.com/thorchain/thornode/-/blob/v3.21.0/x/thorchain/handler_bond_yield.go)
- [Payout helpers](https://gitlab.com/thorchain/thornode/-/blob/v3.21.0/x/thorchain/helpers_bond_yield.go)
- [Provider configuration update](https://gitlab.com/thorchain/thornode/-/blob/v3.21.0/x/thorchain/types/type_node_account.go)
- [Official Bond Yield memo guide](https://dev.thorchain.org/concepts/memos#bond-yield)
- [ADR 029](https://dev.thorchain.org/architecture/adr-029-bond-yield-payouts.html)
