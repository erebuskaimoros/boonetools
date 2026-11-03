# Thorfolio Bond Yield management

Thorfolio's Bond tab supports the THORNode 3.21 payout configuration in each
node row's **payout** action. The table reads `bps` and `payout_target` from
each bond provider. These are preferences for future reward distributions;
they are not a withdrawable balance.

## Configuration

- Enter 0–100%, with up to two decimal places. Zero turns payouts off and clears
  the saved target; the rest of the provider's future reward is rebonded.
- The destination has two choices: **RUNE → bond provider address** and
  **Stream to THORName**. Provider-wallet mode explicitly includes the provider
  address in the memo, so switching back cannot accidentally retain another
  destination. Arbitrary direct THOR addresses are supported by the protocol
  helpers but are not a separate destination option in the form.
- A non-zero memo with no target preserves the chain's stored target. This is
  supported by the plan builder but not exposed as an ambiguous blank form input.
- THORName routes are resolved during review. Names require current provider
  ownership; names with a preferred asset use the affiliate collector. Otherwise
  the THOR alias (or owner) receives RUNE.
- When the provider wallet is connected, **your THORNames** lists its active
  owned names. Selecting one fills its saved preferred asset and receiving alias;
  manual entry remains available. Discovery uses one cached Midgard owner query,
  followed by bounded fresh THORNode ownership/expiry checks. Refresh bypasses
  the owner cache. Alias association alone does not qualify a name, and expired
  or transferred names are omitted. Lookup failures do not prevent manual entry.
- Selecting a THORName reveals its saved asset and receiving address, both
  editable. Manually entered names are loaded and verified before those controls
  appear. Asset choices include native RUNE and available supported pool assets.
  The THORName must already exist and belong to the selected provider; registration
  and ownership transfer are not part of this form. Existing saved name targets
  are loaded when the form opens.
- When the name needs a different preferred asset or chain alias, the review
  first shows a zero-RUNE `~:<name>:<chain>:<address>::<asset>` update. It does
  not change the owner, expiry or payout threshold. The user explicitly confirms
  that this affects all collector payouts and resolution of that chain's alias,
  then signs the name update. A separate check must observe the new settings
  before the bond payout transaction can be reviewed and signed. A submitted
  update is not treated as confirmed and is not automatically sent again.
- Selecting RUNE uses the name's THOR alias, falling back to its owner. Changing
  that receiving address or switching from a preferred asset uses the same
  separate name-update review, with `THOR.RUNE` explicitly clearing the preferred
  asset. Native RUNE requires no pool or external payout-route lookup.
- The review shows the actual receiving address, asset and THORName. Preferred
  asset payouts accumulate in its collector before conversion, are subject to
  swap/outbound fees and the collector's configured threshold, and can be delayed
  by unavailable routes. They are not an immediate swap on every reward.
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
THORName resolution (including the external-chain receiving address) or failed
check stops the operation. Missing receiving aliases cannot pass review.

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

On November 3, 2026, the public Liquify `/thorchain/version` response reported
current 3.21.0. The preferred-asset route was confirmed against that release's
Bond Yield helpers, THORName handler and official guide. Development verification
uses fixture accounts with wallet execution disabled; no transaction is broadcast.
Real-wallet signing and settlement remain user-controlled release checks.

Focused coverage: `tests/position-tracker-bond-yield.test.js` checks memo precision,
checksums and input rejection, provider state mapping, version/Mimir precedence,
ownership and node status, THORName routes, stale-review rejection, direct reads,
owned-name discovery, wallet changes, autofill, and the final pre-signing check.
The existing Thorfolio suites cover the surrounding
bond and address controls.

## Protocol sources

- [THORNode v3.21.0 handler](https://gitlab.com/thorchain/thornode/-/blob/v3.21.0/x/thorchain/handler_bond_yield.go)
- [Payout helpers](https://gitlab.com/thorchain/thornode/-/blob/v3.21.0/x/thorchain/helpers_bond_yield.go)
- [Provider configuration update](https://gitlab.com/thorchain/thornode/-/blob/v3.21.0/x/thorchain/types/type_node_account.go)
- [Official Bond Yield memo guide](https://dev.thorchain.org/concepts/memos#bond-yield)
- [ADR 029](https://dev.thorchain.org/architecture/adr-029-bond-yield-payouts.html)
- [THORName preferred-asset configuration](https://dev.thorchain.org/affiliate-guide/thorname-guide.html)
- [Midgard owner lookup API](https://gitlab.com/thorchain/midgard/-/blob/develop/openapi/openapi.yaml)
