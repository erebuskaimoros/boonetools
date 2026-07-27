# BooneTools Performance Architecture

## Request-path rule

Dashboard GET handlers must not contact THORNode, Midgard, Dune, RPC, or chain
indexers. Provider work belongs in scheduled ingestion or snapshot jobs. Public
handlers read a durable Postgres read model, optionally execute a bounded
cursor/page query, and return a compact response.

```text
providers -> scheduled ingestion -> canonical Postgres tables
          -> durable mixed-cadence THORNode core snapshot
          -> scheduled read-model publishers -> api_read_models
          -> short single-flight row cache -> public handlers -> Caddy compression
```

The in-process row cache lasts three seconds and coalesces concurrent reads of
the same model. It never replaces Postgres as source of truth: scheduler reads
bypass it, publication invalidates it, and freshness/age are recomputed for
every response.

Volume-producing read models follow the canonical accounting contract in
[`volume-accounting.md`](./volume-accounting.md). Backend aggregates always use
executed-leg volume; any route-notional UI exception is an explicit,
presentation-only field.

## Durable models

| Public endpoint | Model key | Publisher | Cadence / TTL |
| --- | --- | --- | --- |
| internal + `/network-snapshot` | `thornode-core:v1` | `boonetools-thornode-core-snapshot` | 15s / 45s |
| `/status-live` | `status-live:v1` | `boonetools-status-live` | 15s / 45s |
| `/status-dashboard` | `status-dashboard:v1` | `boonetools-status-dashboard` | 1m / 150s |
| `/treasury-snapshot` | `treasury-snapshot:v1` | `boonetools-treasury-snapshot` | 5m / 10m |
| `/rapid-swaps-summary` | `rapid-swaps-summary:v1` | `boonetools-analytics-read-models` | 1m / 150s |
| `/rapid-swaps-swap-history` | `rapid-swaps-market-history:v1` | `boonetools-rapid-swaps-market-history` | 30m / 60m |
| `/node-votes-summary` | `node-votes-summary:v1` | `boonetools-node-votes-summary` | 1m / 150s |
| `/app-layer-live-state` | `app-layer-live-state:v3` | `boonetools-app-layer-live-state` | 2m / 5m minimum |
| `/app-layer-base-layer-earnings` | `app-layer-base-layer-earnings:v1` | `boonetools-analytics-read-models` | 1m / 330s |
| `/app-layer-base-fees` | `app-layer-base-fees:v1` | `boonetools-analytics-read-models` | 1m / 330s |
| `/app-layer-reserve-payments` | `app-layer-reserve-payments:v1` | `boonetools-analytics-read-models` | 1m / 330s |
| `/tc-fee-dash` | `tc-fee-dash:v1` | `boonetools-analytics-read-models` | 1m / 15m |

The core publisher is the sole scheduled owner of reusable current THORNode
state. It refreshes `lastblock` every 15 seconds; inbound addresses, Mimir, and
node-Mimir state every minute; network and pools every two minutes; nodes every
five minutes; constants every fifteen minutes; and Midgard churns every ten
minutes. Status, Node Votes, Treasury, Rapid Swaps, NodeOp, App Layer, and
stable browser reads consume those persisted fields instead of repeating the
same provider requests in separate processes.

The Status page merges `/status-live` into the heavier minute-scale dashboard
snapshot. The live lane contains only current network, chain, and churn values;
it never repeats block-history, stuck-transaction, or vote work. Browser polling
pauses in hidden tabs and performs an immediate conditional read on return. The
minute publisher consumes this same live read model instead of repeating the
THORNode/Midgard network fan-out.

Provider-backed Node Votes and Rapid market history have independent locks,
processes, and deadlines. A slow Dune refresh therefore cannot hold the
database-summary lock or delay App Layer, Rapid summary, or TC Fee snapshots.
Rapid market history refreshes incremental overlap windows and retains the
last successful segment and its original watermark when a provider fails.
When Dune is unavailable, the Midgard fallback splits long history ranges into
sequential requests of at most 400 intervals, matching Midgard's provider cap.

## Response and failure contract

- A failed publisher never overwrites a last-good model.
- Provider cooldowns are shared in Postgres by provider hostname. Rate-limit or
  breach responses cool the provider for at least one hour; ordinary transport
  failures cool it briefly, preventing independent systemd jobs from retrying
  the same unavailable host.
- Every THORNode, Midgard, and RPC wrapper identifies itself with the canonical
  `x-client-id: BooneTools` header.
- `THORNODE_URLS` and `MIDGARD_URLS` accept ordered provider lists, so a
  dedicated node can replace the public defaults without a release.
- The stuck-transaction scanner persists status/details by transaction and
  queue fingerprint, so unchanged queue entries reuse their previous lookup.
- App Layer balance/action calls are bounded by a shared concurrency limit;
  collector config and contract history refresh only every fifteen minutes.
- Stale data is explicit in response metadata and `X-Boone-Cache`/age headers.
- Strong ETags are deterministic and representation-specific for legacy and v2
  response shapes.
- Drill-down data uses bounded cursor/page endpoints; summary models never carry
  unbounded raw histories.
- Caddy serves `zstd` or `gzip` when the client advertises compression.
- Read-model run history is retained for 30 days; runs referenced by a current
  model are preserved.

## Release budgets

The deploy gate runs `scripts/perf-smoke.mjs` from the production host against
the public origin. This keeps DNS/TLS distance stable while still exercising
Caddy and the complete public request path. It checks compression plus these
cold request ceilings:

| Surface | Latency | Compressed bytes |
| --- | ---: | ---: |
| Status live | 500ms | 5KB |
| Status | 750ms | 25KB |
| Treasury | 1.5s | 200KB |
| App Layer live | 1s | 200KB |
| App Layer earnings | 1s | 150KB |
| App Layer fees | 1s | 100KB |
| App Layer Reserve | 1s | 150KB |
| Node Votes summary | 1s | 150KB |
| Rapid summary/history | 1s | 150KB each |
| TC Fee | 1s | 250KB |

The deploy also sends 50 concurrent Status requests. The route-level cached
concurrency caps and single-flight row cache are intended to absorb that burst
without turning it into 50 Postgres JSONB reads.

Run the same gates locally with:

```bash
npm run perf:smoke -- --base http://127.0.0.1:8787/functions/v1
npm run perf:smoke -- --base http://127.0.0.1:8787/functions/v1 --endpoint status --requests 50 --concurrency 50
```

## Deployment safety

The backend deploy creates a checksummed immutable release, installs its
dependencies before production mutation, and serializes backend/frontend
activation through one host lock. It quiesces writers only for migration and
cutover, atomically changes `/opt/boonetools-backend/current`, primes models in
dependency order, verifies every timer's next trigger, and runs public
performance and all-domain health gates. Failure after cutover switches the
symlink and systemd manifest back to the previous verified release. Caddy is
owned by Web Ops and is not modified or reloaded by an application deploy.
