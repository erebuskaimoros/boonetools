# Architecture consolidation

BooneTools is a Vite SPA backed by one Node/Postgres service. The July 2026
consolidation established these ownership boundaries:

- `shared/` owns runtime-neutral blockchain, provider transport, and Rapid
  Swaps domain logic. Backend code must not import frontend `src/` modules.
- `src/lib/api/boonetools.js` is the browser's single BooneTools API client.
  Feature-specific environment variables are compatibility aliases only.
- `backend/src/shared/` owns server orchestration around providers, caches,
  queues, and domain persistence. Independent jobs remain independent systemd
  units so one stalled source cannot block unrelated ingestion.
- `backend/migrations/` is the canonical database history. The migration runner
  records each filename in the same transaction as its schema/data changes.

## Shared data contract

Read-only routes are public and rate-limited. Legacy payloads retain their
shape and receive additive `meta`; clients can request the v2 `{ data, meta }`
envelope with `schema_version=2` or
`application/vnd.boonetools.v2+json`.

Rapid Swaps, node votes, and Rujira Reserve payments store one canonical row
per event plus `event_source_observations` for every provider sighting. Source
priority is applied inside `ON CONFLICT` SQL, and first/last-seen timestamps
are monotonic under replay and concurrent writers.

## Expensive reads

- Dashboard GETs are provider-free. Status, Treasury, Node Votes, Rapid Swaps,
  App Layer, and TC Fee summaries are scheduled into the shared
  `api_read_models` table and served through a three-second single-flight row
  cache. Stale/partial source lanes remain explicit and failed builds preserve
  the prior model.
- Provider-backed Node Votes and Rapid market-history publishers have separate
  systemd units, advisory locks, deadlines, and cadences so Dune or THORNode
  latency cannot block database-only summaries. Rapid market history chunks
  Midgard fallback ranges at its 400-interval provider limit.
- Summary payloads contain bounded aggregates. Raw vote/event detail remains on
  cursor-paginated routes, and the common Rapid first page is embedded in its
  summary model.
- Bond History normal reads only return cached data and enqueue durable work.
  Cold misses return `202`; the frontend polls the cache-only status mode.
- Provider requests share configurable ordered fallback, challenge detection,
  response validation, caller cancellation, transport deadlines, and the
  canonical `BooneTools` client identifier.
- Reusable current THORNode state has one durable owner:
  `boonetools-thornode-core-snapshot`. Field cadences range from 15 seconds for
  height to fifteen minutes for constants. Status, Node Votes, Treasury,
  NodeOp, Rapid Swaps, App Layer, and the frontend's stable THORNode helpers
  read that model rather than repeating `/lastblock`, `/mimir`, `/nodes`,
  `/network`, `/pools`, or `/inbound_addresses`.
- Hierarchical provider circuit breakers live in Postgres, making cooldowns
  effective across systemd oneshot processes. Ordinary failures are scoped to
  a configured service base; confirmed 429/`Retry-After` responses alone use a
  hostname-wide breaker. App Layer static routes use a slower
  persistent refresh and bounded concurrency; stuck-transaction status/details
  reuse is keyed by transaction plus queue fingerprint.
- Historical THORChain pool/Oracle acquisition is persisted by height in
  `thorchain_market_snapshots`. Pool Dislocation and Wasm analytics reuse the
  same raw snapshot while retaining feature-owned derivation methods.
- Caddy compresses API responses, deploys enforce public latency/payload gates,
  and failed rollouts restore backend/shared code, systemd state, the API
  process, and Caddy.

## Frontend surface

The active SPA entry is `src/main.js` and routing lives in `src/App.svelte`.
The unused SvelteKit shell, THORWizard viewer/assets, and music playlist are
recoverable under `archive/` and are excluded from production output. App
Layer, Rapid Swaps, and TC Fee Dash split data/model/chart/presentation work
into focused modules and share terminal alerts and chart tokens.

CI enforces import boundaries, tests frontend and backend domains, checks the
production Svelte surface, and ratchets unreachable-file, source-line, and
public-asset budgets.
