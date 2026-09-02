# BooneTools Website Local Knowledge

This directory contains website/backend-specific protocol notes and session history.

- Use the shared [reference base](../../../knowledge/reference-base.md) to locate authoritative Thornode/OpenAPI, Midgard, Rujira, deployment, client, and XMR sources. Open only the relevant section and source.
- Primary local API references are [the Thornode API guide](../docs/thornode-api-reference.md), [the consumer OpenAPI snapshot](../docs/thornode-openapi.yaml), and [the Midgard Swagger snapshot](../docs/midgard-swagger.json).
- Start with [sessions/_index.md](./sessions/_index.md) for the local execution trail.
- [fee-collector-accounting.md](./fee-collector-accounting.md) — balance-delta method for auditing on-chain fee collectors when senders aren't enumerable or the collector converts assets internally.
- [app-layer-post-unfreeze-2026-09-02.md](./app-layer-post-unfreeze-2026-09-02.md) — stale earnings midnight lookup and missing on-chain collector schedules after the Wasm unfreeze.
- [wasm-arb-economics.md](./wasm-arb-economics.md) — `/wasm-arb-economics` metric definitions, transaction-scoped Rujira fee attribution, post-change time-series compaction, and monitoring guardrails.
- [status-dashboard.md](./status-dashboard.md) — `/status` data sources, chain/LP state derivation, historical vote lane, and failure behavior.
- [pol-tracker.md](./pol-tracker.md) — `/pol-tvl` same-height daily synth backing, locked Treasury LP, legacy Reserve POL, and System Income POL accounting.
- [system-income-pol.md](./system-income-pol.md) — `/pol-tracker` block-live funding, deployments, reconciled positions, and estimated fee share.
- [burn-tracker.md](./burn-tracker.md) — route-specific system-income RUNE burn metrics, daily ingestion, cumulative accounting, and source semantics.
- [pool-analysis.md](./pool-analysis.md) — pool-generated liquidity fees, two-sided historical depth, and the chart line toggle.
- [tc-fee-dash.md](./tc-fee-dash.md) — `/tc-fee-dash` historical fee-capture metrics plus its live Mimir/default system-income allocation and Sankey flow contract.
- [slow-block-consensus-wasm-report-2026-08-06.md](./slow-block-consensus-wasm-report-2026-08-06.md) — three-window analysis of >10-second block intervals, scheduled proposer failures, final commit behavior, and Wasm/FIN activity.
- [architecture-consolidation.md](./architecture-consolidation.md) — runtime ownership, unified API/backend contract, canonical provenance, queued reads, archive policy, and CI ratchets.
- Use the shared [BooneTools project page](../../../knowledge/projects/boonetools.md) for durable product context.
- Use the shared [analytics and tooling workstream](../../../knowledge/workstreams/analytics-and-tooling.md) for cross-project relationships.

Keep implementation/session detail here. Promote stable cross-project conclusions into the shared wiki and append to `../../../knowledge/log.md`.
