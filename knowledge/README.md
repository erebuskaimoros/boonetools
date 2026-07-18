# BooneTools Website Local Knowledge

This directory contains website/backend-specific protocol notes and session history.

- Use the shared [reference base](../../../knowledge/reference-base.md) to locate authoritative Thornode/OpenAPI, Midgard, Rujira, deployment, client, and XMR sources. Open only the relevant section and source.
- Primary local API references are [the Thornode API guide](../docs/thornode-api-reference.md), [the consumer OpenAPI snapshot](../docs/thornode-openapi.yaml), and [the Midgard Swagger snapshot](../docs/midgard-swagger.json).
- Start with [sessions/_index.md](./sessions/_index.md) for the local execution trail.
- [fee-collector-accounting.md](./fee-collector-accounting.md) — balance-delta method for auditing on-chain fee collectors when senders aren't enumerable or the collector converts assets internally.
- [status-dashboard.md](./status-dashboard.md) — `/status` data sources, chain/LP state derivation, historical vote lane, and failure behavior.
- [architecture-consolidation.md](./architecture-consolidation.md) — runtime ownership, unified API/backend contract, canonical provenance, queued reads, archive policy, and CI ratchets.
- Use the shared [BooneTools project page](../../../knowledge/projects/boonetools.md) for durable product context.
- Use the shared [analytics and tooling workstream](../../../knowledge/workstreams/analytics-and-tooling.md) for cross-project relationships.

Keep implementation/session detail here. Promote stable cross-project conclusions into the shared wiki and append to `../../../knowledge/log.md`.
