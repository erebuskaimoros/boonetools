# Session 1 - App Layer Fee Diagnosis and Endpoint Deprecation

> Date: 2026-08-02
> Focus: Diagnose the App Layer to Base Layer dashboard regression and remove deprecated provider hosts

## Summary

Diagnosed the dashboard regression as a partial ingestion outage in generated-fee lane 03, not a Rujira contract redeployment or event-schema change. Removed every deprecated Chainnet-managed provider reference from the website runtime, tooling, tests, documentation, generated artifacts, and knowledge while preserving explicit provider-list configuration for verified alternatives.

## Work Done

- Verified all five Rujira revenue collectors remain on their existing production addresses and code 159.
- Verified the shared THORChain swap contract migrated in place from code 173 to 182 and that the current parser still classifies post-migration events correctly.
- Traced both Rujira listeners to the same silent Liquify Tendermint WebSocket failure and confirmed the former fallback hosts no longer resolve.
- Confirmed the generated-fee lane was roughly two days behind while live-state, Base Layer earnings, and scheduled Reserve-payment ingestion remained current.
- Confirmed Dune query 7620091 was returning HTTP 402 and the legacy Midgard path was still traversing historical backfill instead of polling the live head.
- Removed deprecated provider defaults from backend configuration, frontend clients, Vite development proxies, scripts, documentation, public artifacts, and historical notes.
- Kept failover capability opt-in through ordered provider lists and updated tests to use neutral test-only fallback origins.
- Ran exhaustive ignored-file-aware searches and found no remaining deprecated host references.
- Verified the full frontend and backend test suites, repository checks, and production frontend build.

## Discoveries

- A fresh listener heartbeat does not prove block ingestion: the current listener reports running on socket open before any subscription acknowledgment or block frame arrives.
- The generated-fee read model can republish old source data with a fresh wrapper timestamp and `stale: false`, so source height/time freshness must be checked separately.
- Reserve payments stayed current because their scheduled cadence scanner compensates for WebSocket failure; generated fees lack an equivalent independent head-tail scanner while backfill is incomplete.
- Provider alternatives should be explicit verified configuration, not baked-in public-host assumptions.

## Files Changed

| File | Change |
|------|--------|
| `backend/src/lib/config.js` | Removed deprecated fallback defaults and kept ordered provider-list configuration |
| `backend/src/shared/midgard.js` | Made testable/custom provider lists available to convenience calls |
| `shared/rapid-swaps/backend.js` | Defaulted Rapid Swap provider access to Liquify only while retaining explicit custom bases |
| `src/lib/api/*`, `src/lib/utils/api.js`, `src/lib/node-operator/api.js` | Removed deprecated frontend providers and single-provider retry paths |
| `src/lib/DynamicFeeDashboard.svelte`, `vite.config.js` | Removed the deprecated browser WebSocket and development proxy fallback |
| `scripts/rujira-*.mjs`, `updateIpInfo.js` | Removed deprecated script endpoints |
| `backend/.env.example`, `README.md`, `docs/*` | Updated configuration and provider documentation |
| `public/data/rujira-base-layer-fees/*` | Removed deprecated origins from generated metadata |
| `tests/*`, `backend/tests/*` | Updated provider defaults and preserved generic failover coverage with test-only origins |
| `knowledge/*` | Recorded provider deprecation and sanitized historical endpoint references |

## In Progress

The endpoint cleanup is complete locally but has not been deployed. The generated-fee ingestion lane remains stalled until a working live provider or independent REST/Midgard head scanner is implemented and the missing blocks are caught up.

## Next Steps

- [ ] Deploy the endpoint cleanup and verify production processes no longer load deprecated provider values.
- [ ] Add an independent bounded head-tail scanner for generated fees and catch up from block 27,235,929.
- [ ] Require a subscription acknowledgment or first block before marking WebSocket listeners running.
- [ ] Make App Layer lane freshness depend on source height/time and surface stale generated-fee data in the UI.
- [ ] Restore Dune capacity or reduce query usage so query 7620091 can resume canonical ingestion.
