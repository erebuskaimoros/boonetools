# Vote Tracker

## Direct protocol Mimir changes

Direct `set_mimir` changes are protocol actions, not validator votes. They are
stored in `protocol_mimir_changes`, separately from `set_node_mimir` rows in
`node_votes`, and merged only into a key's Effective Value History. Changes
with a transaction-local `security` message are labeled `Protocol safety
event`; other direct changes are labeled `Direct protocol event`. Neither is
assigned a node/operator or a 0-of-N vote count.

The consolidated listener subscribes to `set_mimir.key EXISTS` for live
ingestion. The node-vote backfill also searches that indexed RPC event over six
months on its first run and uses its own rolling watermark afterward. A
`set_mimir` with the same key and value as a `set_node_mimir` in one transaction
is vote-driven and is not duplicated as a protocol event. Direct-only keys
still appear in By Vote so current Mimir state has its recorded protocol
history.

## Upgrade vote coverage

The Vote Tracker stores validator-scheduled upgrade stance changes in the
existing `node_votes` event table under compatibility keys such as
`UPGRADE-3.20.0`. `approve_upgrade` maps to `approve`; `reject_upgrade` maps to
`reject`. A proposal transaction already emits its implicit
`approve_upgrade`, so `propose_upgrade` is searched for transaction discovery
but is not stored as a second vote.

CometBFT event queries support `AND`, not `OR`. WebSocket ingestion therefore
uses separate subscriptions for Mimir, proposal, approval, and rejection
events. Historical upgrade catch-up likewise runs separate paginated searches
and deduplicates transactions before parsing their complete event lists. This
upgrade lane runs even when Dune's Mimir-only query succeeds.

Indexed history is not authoritative for current upgrade quorum. The public
RPC index can omit recent upgrade transactions, and churn changes which stored
approvals count without emitting another vote. The minute summary publisher
therefore overlays `/thorchain/upgrade_proposals`, joins its voters to the
current active-node roster, and publishes the normalized proposals alongside
historical rollups.

Upgrade quorum is equal-validator `ceil(2N/3)` over current active validators.
Only `approve` counts toward quorum. Rejects remain visible stances, inactive
voters remain historical context, and an expired proposal is never presented
as current consensus after it disappears from the live endpoint.

## Active vote status

The consensus cell expands into a current active-validator status display for
both pending and passed votes. Every active node is grouped under its current
vote value, with nodes that have no current stance placed in a final `NOT
VOTED` group. The summary payload must therefore retain the complete node list
for every value; truncating the `values[].nodes` arrays makes the status display
misclassify omitted voters as non-voters.

## Current Mimirs and constants

The third Vote Tracker tab lists current THORChain configuration without adding
browser-to-THORNode traffic. The minute `node-votes-summary:v1` payload carries
the latest Mimir and constants fields already maintained by
`thornode-core:v1`, together with independent completeness and source-update
timestamps. A missing constants snapshot degrades only this tab and does not
block vote or upgrade publication.

Rows are ordered as two explicit groups: every current Mimir first, followed
by every protocol constant. Constants are not removed when a matching Mimir
exists; the default remains visible and is marked `OVERRIDDEN` with the active
Mimir value so the page distinguishes current network state from the compiled
default.
