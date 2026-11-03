# Preferred-asset Bond Yield payouts

November 3, 2026: implementation in `feat/thorfolio-payout-assets`, managed
worktree `/Users/boonewheeler/.codex/worktrees/thorfolio-payout-assets/website`.
Prepared and approved for frontend deployment. The earlier Pool Analysis cooldown recovery work in
`near-net-issuance/website` was preserved.

Liquify reported current network 3.21.0, `BondYieldEnabled=1`, `THORNames=1`.
Verified against THORNode v3.21.0 `helpers_bond_yield.go`,
`handler_manage_thorname.go`, `memo/memo_thorname.go` and the official
THORName/Bond Yield guides.

Bond Yield's memo has no independent asset field. An owned THORName supplies its
preferred asset and receiving-chain alias. Existing UI accepted a name but did
not provide asset setup, and could approve a preferred asset with no chain alias.
The missing-alias test was run failing before delegating the model fix.

The modal now selects an available pool asset, an already registered provider-owned
THORName and a mainnet receiving address. If the name needs changing, only the
zero-RUNE THORName update is offered for signature. It preserves owner, expiry
and threshold. The user acknowledges impact on the name's other payouts and alias
resolution, then separately rechecks confirmation and signs BONDYIELD. Submission
is not confirmation; a pending update cannot be automatically resent. No new name
registration or automatic second transaction is included.

Fresh checks require provider membership, activation, ownership, unexpired name,
available pool, mainnet address checksum and a usable payout route. The complete
review is rechecked immediately before wallet handoff, including actual receiving
address and name setup state. Off/native RUNE paths do not fetch external routes.

Validation: 112 Thorfolio tests passed, including 34 Bond Yield tests; frontend
boundaries/surface/Svelte checks passed (0 errors, existing 56 warnings), production
build passed, desktop live-data form and 390px fixture preview checked. No wallet
connected or transaction sent. The preview substitutes a throwing executePlan.

Dev app: port 4184, `outputs/payout-preview/dev.config.js`, reads production
snapshots with unrelated collectors disabled. Fixture preview: port 4185,
`outputs/payout-preview/vite.config.js`. These outputs are local artifacts only.

Two existing dependency versions are now direct dependencies for checksum
validation: bitcoinjs-lib 6.1.9, cashaddrjs 0.4.4. No wallet SDK versions changed.
Main's unrelated 265a69a IP-data update had exceeded the surface budget by exactly
76 bytes; the public-byte baseline was corrected by that amount to permit checks.

Follow-up: the connected provider's active owned THORNames now populate a chooser
in THORName mode. Selecting one fills its preferred
asset and matching receiving-chain alias. Midgard `/thorname/owner/{address}` is
the discovery index, with fresh THORNode ownership and expiry verification; alias
reverse lookup cannot establish ownership. Lookup concurrency is capped at four,
same-owner requests are deduplicated, and refresh bypasses the owner cache.
Disconnect/account changes clear choices and ignore late responses. Manual entry
remains available during indexing lag, no results or outages.

Live read-only verification found four eligible names for provider …pqx8:
jj, jy, vv and yy (all currently native RUNE). Provider …hxff returned the expected
Midgard 404/no indexed names. Browser fixture checks verified selection, autofill,
manual entry, and review invalidation after an asset change. No signing performed.

The destination flow was then simplified to exactly two options: RUNE to the
bond-provider address, or stream to THORName. Selecting/loading a verified name
reveals its saved asset/address for editing. Native RUNE is now an explicit name
asset choice, including THOR alias edits and clearing an existing preferred asset
through the `THOR.RUNE` sentinel confirmed in the 3.21 handler. Missing native aliases
default to the owner; external assets require a usable receiving alias. Manual
name loads validate ownership/expiry before displaying editable settings. Tests
cover these native updates, manual name authority, and unchanged provider paths.
