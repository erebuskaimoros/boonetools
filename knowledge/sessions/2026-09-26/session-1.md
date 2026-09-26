# Independent L1 vault balance release

The user requested independent external-chain vault balances to reveal losses
that THORNode accounting might not observe, then explicitly authorized push and
deployment. This change is isolated on `feat/vault-l1-balances`, based on current
production main; unrelated primary-checkout work is excluded.

## Changes and evidence

- The shared visitor snapshot acquires balances for 12 external chains. The
  details tab shows independent observations, THORNode expectations, differences,
  freshness, coverage, and provider failures. Drained zeros stay visible.
- V6.1 routers use direct token custody. Legacy ETH/BSC router allowances get
  separate physical-backing checks at the same L1 block. Unknown custody models
  and unrecognized assets do not receive a fabricated independent balance.
- The implementation smoke test read 250 recorded/nonzero balance rows and 27
  legacy-router backing checks over five live vaults. The local browser fixture
  verified a zero balance and provider outage. Thirty-one focused tests passed,
  along with the frontend build and architecture/Svelte checks.
- Provider endpoint and preview friction were logged as papercuts. No backlog
  review was requested or performed.

See [the source and operations contract](../../../docs/vault-explorer-balances.md)
and [implementation notes](../../vault-l1-balances-2026-09-26.md).

## Publication handoff

At this record's commit, deployment is pending. Publish the exact commit to
production main, await its `verify` check, deploy backend then frontend, and
verify the public snapshot after the normal minute worker runs. No migrations,
new timers, forced backfills, or backend secrets are needed. The deployment
outcome belongs in the task result and shared project log; this record describes
what was reviewed before activation.
