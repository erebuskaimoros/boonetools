# Vote Tracker

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
