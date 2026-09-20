# Bond Tracker APY investigation — September 20, 2026

## Findings and release status

The current-churn APY is understated before the expected churn boundary.
The correction and historical-height safeguard are deployed in release
`6793446eb5f8c5d8abcaa87846f8f1d3fabf3f85`; verification is recorded below.
The latest three completed churns for sampled bond provider `...hxff` match
height-verified historical state exactly. This is a sample, not verification
of every address or older cached row. No affected address was supplied with
the initial report.

## Current churn

`src/lib/bond-tracker/apy.js` annualized the accrued `current_award` over
`max(nominal churn duration, elapsed duration)`. Before churn is due, this
divides a partial period's earnings by an entire churn's duration.

THORNode `x/thorchain/querier.go`, `getNodeCurrentRewards`, calculates the
node's share of the accumulated `network.BondRewardRune`, adjusted for its
effective bond and slash points. It does not project rewards to the next
churn. The nominal-period behavior was introduced in website commit
`26c590018489891e2bc9dfad4df8fafb599df124` on May 2, 2026. Production bundle
`/assets/BondTrackerV2-BISbyp1Y.js` still contained that calculation when checked.

Corrected behavior annualizes the actual accrued award over elapsed blocks
(or elapsed seconds when block metadata is unavailable), retaining the
5% early-churn floor. Actual reward amounts remain unchanged. Overdue churns
still use their full elapsed duration. Missing timestamps do not manufacture
an interval starting at the Unix epoch.

Sample using the public `/functions/v1/network-snapshot` node observation
from 2026-09-20 20:45:47 UTC:

- Latest churn: height 27,914,370, September 20 at 17:25:17 UTC.
- Current height: 27,916,326; 1,956 / 43,200 blocks elapsed (4.53%).
- Provider `...hxff`: 3,772,826.87702212 RUNE bonded, 115.41047801 RUNE accrued.
- Three nodes active; node `...tacs` is now standby and contributes no current
  reward, while its bond remains in the aggregate principal.
- The same ten-block timing method used by the UI gives 6.1445 seconds/block
  from verified block timestamps at heights 27,916,316 and 27,916,326.
- Existing calculation: **0.3643% APY**. Corrected calculation with the early
  floor: **7.5437% APY**. Without that conservative floor: 8.3625%.

These numbers describe one fixed snapshot, not a promised yield or a current
quote. The short block-time estimate and five-minute node observation cadence
remain sources of estimation noise.

## Completed churn verification

Read cached production history with `refresh=status` to avoid queuing work.
There were no missing interior churns among this provider's 102 cached rows.
For the newest three rows, queried all four current bonded nodes (`...ne9y`,
`...nz4v`, `...s69g`, `...tacs`) at each churn height minus one using RPC
`abci_query`, path `/types.Query/Node`. Required response code zero and response
height equal to the requested height; decoded the stable protobuf fields in
`proto/thorchain/v1/types/query_node.proto`.

Recomputing `calculateBondHistoryRow` from these responses matched both
`rune_stack` and `user_bond` in production with **zero base-unit difference**.

| Churn date (UTC) | Height | Period days | Provider rewards (RUNE) | APY |
| --- | ---: | ---: | ---: | ---: |
| September 14 | 27,825,709 | 13.78955 | 43,391.12153927 | 36.1752% |
| September 17 | 27,870,660 | 3.21911 | 5,390.24290980 | 17.6386% |
| September 20 | 27,914,370 | 3.12395 | 3,395.73243236 | 11.1058% |

The completed-churn formula uses the actual timestamp difference, accrued
rewards after operator fees, and preceding stack as principal. The observed
decline in this sample is explained by lower realized reward rates. This does
not identify why network rewards declined or rule out address-specific issues
such as mid-period bond changes, missing cached churns, or older bad snapshots.

## Historical REST caveat

Liquify REST calls to `/thorchain/node/{address}?height=...` and
`/thorchain/network?height=...` returned current state despite requested past
heights, including requests with Cosmos height headers. For example, a network
request for height 27,914,369 returned response metadata
`grpc-metadata-x-cosmos-block-height: 27916354`. RPC queries returned distinct,
correctly height-tagged historical state. This reproduces the provider caveat
already documented during Financials work; HTTP 200 is not historical proof.

The previous Bond History acquisition validated payload structure without
checking response height. The patch switches historical node and network reads
to RPC with exact-height validation, and the repair script uses the same path.
Separate v2 observation namespaces prevent reuse of immutable, unverified v1
raw data and empty-churn proofs. Existing materialized history is preserved:
the three sampled rows are accurate, and this is not a global history rebuild.

## Validation

- Added two regression tests first and observed both fail against the old
  current-churn calculation (129,600 elapsed seconds incorrectly became 259,200).
- 35 focused Bond Tracker, node reuse, history calculation, and acquisition
  tests pass after the correction.
- `npm run build` passes; existing Svelte/bundle-size warnings remain.
- No commit, push, deployment, or production-data mutation.

## Patch and deployment

The user subsequently authorized patching and deployment. The release includes
both the current-APY correction and verified historical acquisition. Historical
height regression tests were written and observed failing against the previous
implementation before the acquisition change.

Release validation: 54 focused frontend/backend bond tests pass. A live check
of the new RPC decoder at node height 27,914,369 and network height 27,914,370
reproduced the sampled provider's stored stack, principal, and RUNE price
exactly. The pre-release browser baseline was 0.38% aggregate APY.

Release `6793446eb5f8c5d8abcaa87846f8f1d3fabf3f85` passed
[CI](https://github.com/erebuskaimoros/boonetools/actions/runs/35537775358)
and was deployed backend first, then frontend, on September 20. Backend
activation was routine, with no migrations and only the API selected for a
persistent restart. The Bond History timer remained enabled and its latest
job completed successfully. Existing unrelated stale-cache warnings were
reported by health checks and left to their normal collectors.

Post-deployment verification:

- Backend and frontend release pointers both resolve to the release above.
- Public HTML loads `/assets/index-CryWkBeO.js`; its bytes and the lazy Bond
  Tracker bundle `/assets/BondTrackerV2-BlxdqBpz.js` match the server artifacts
  by SHA-256.
- The deployed RPC helper returned node `...ne9y` at exactly 27,914,369 and
  network state at exactly 27,914,370. Historical award was 1,039.47874569 RUNE
  and RUNE price was 0.56269725, matching the independently verified sample.
- The live browser shows **7.52% APY** for provider `...hxff`, compared with
  **0.38%** before deployment; accrued rewards moved from 117.5 to 117.7 RUNE
  between observations.
- All 102 cached historical rows are identical to the pre-deployment response.
  No historical rebuild or cache deletion was performed.
