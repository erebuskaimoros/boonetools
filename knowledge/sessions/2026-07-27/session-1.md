# Session 1 - THORNode Request Efficiency

> Date: 2026-07-27
> Focus: Consolidate reusable THORNode state and reduce duplicated provider traffic

## Summary

Implemented the THORNode performance correction across the BooneTools backend and active frontend adapters. Reusable current network state now has one durable mixed-cadence publisher, provider failures are coordinated across processes, and high-fan-out jobs reuse persisted data instead of independently repeating the same calls.

The known fixed THORNode request baseline is expected to fall from roughly 56,700 to 26,100 requests per day before address- and transaction-specific work. All backend tests, frontend tests, architecture checks, Svelte diagnostics, and the production build pass.

## Work Done

- Added `thornode-core:v1`, with independent cadences for height, inbound addresses, Mimir, node Mimirs, network, pools, nodes, constants, and churn history.
- Migrated Status, Node Votes, Treasury, Rapid Swaps, NodeOp, App Layer, and stable browser reads to the durable snapshot.
- Added Postgres-backed provider-host cooldowns for THORNode, Midgard, RPC, and Rapid Swaps, including Liquify breach-response detection.
- Added ordered `THORNODE_URLS` and `MIDGARD_URLS` configuration plus a consistent `x-client-id: BooneTools` header.
- Made stuck-transaction status/details incremental by transaction and queue fingerprint, with bulk JSONB persistence and time-aware overdue calculation.
- Split App Layer route cadences, bounded volatile route concurrency, and persisted last-good route values.
- Added field-level and read-model freshness checks so stale provider data is not republished as current.
- Added the database migration, systemd publisher/timer, deploy priming order, tests, operational documentation, and architecture notes.

## Discoveries

- The largest duplication came from independent systemd jobs polling the same small set of current THORNode endpoints at unrelated cadences.
- Liquify's failure state must be coordinated across processes; an in-memory circuit breaker does not protect multiple oneshot jobs sharing the same source IP.
- Stuck-transaction status payloads can be cached, but elapsed blocks must be derived from the current height and original scheduled height so cached records can cross the overdue threshold correctly.
- JavaScript arrays passed through node-postgres are encoded as Postgres arrays, so bulk `jsonb_to_recordset` inputs must be explicitly JSON-stringified.
- Public fallback endpoints remain operationally uncertain; configurable ordered provider lists allow a dedicated node to be inserted without another application release.

## Files Changed

| File | Change |
|------|--------|
| `backend/migrations/030_thornode_efficiency.sql` | Added provider circuit-breaker and stuck-lookup cache tables |
| `backend/src/shared/thornode-core-snapshot.js` | Added the durable mixed-cadence core publisher and freshness contract |
| `backend/src/shared/provider-cooldown.js` | Added shared provider-host cooldown lifecycle |
| `backend/src/shared/stuck-transactions.js` | Added incremental lookup persistence and linear fingerprint construction |
| `backend/src/shared/app-layer-live-state.js` | Added mixed route cadences, concurrency bounds, and last-good reuse |
| `backend/src/{handlers,jobs,treasury}/` | Migrated Status, votes, NodeOp, Rapid, and Treasury consumers to the core model |
| `backend/src/shared/{thornode,midgard,rpc,rapid-swaps}.js` | Unified provider identification, ordered fallback, and cooldown behavior |
| `src/lib/api/core-snapshot.js` | Routed stable browser THORNode reads through the BooneTools backend |
| `src/lib/api/{thornode,midgard}.js`, `src/lib/utils/api.js` | Added core resolution and canonical provider headers |
| `ops/systemd/boonetools-thornode-core-snapshot.*` | Added the 15-second core publisher service and timer |
| `scripts/deploy-boonetools-backend-remote.sh` | Primed the core model before dependent publishers |
| `backend/tests/`, `tests/rapid-swaps-backend.test.js` | Added cadence, outage, cooldown, concurrency, and incremental-lookup coverage |
| `docs/`, `knowledge/` | Documented the architecture, runtime configuration, and failure behavior |

## In Progress

Production deployment and post-deploy verification follow this commit and push.

## Next Steps

- [ ] Deploy the pushed commit and verify migration, timer, read-model, and public health gates.
- [ ] Monitor `thornode-core:v1` freshness and field warnings during the first production cycles.
- [ ] Confirm shared provider cooldown rows behave correctly during the next rate-limit or transport failure.
- [ ] Measure production provider-call volume and compare it with the estimated 54% fixed-baseline reduction.

