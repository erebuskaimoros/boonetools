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

- Status uses `/network-snapshot`, with per-field partial failure and stale
  cache fallback.
- Bond History normal reads only return cached data and enqueue durable work.
  Cold misses return `202`; the frontend polls the cache-only status mode.
- Provider requests share ordered fallback, challenge detection, response
  validation, caller cancellation, and transport deadlines.

## Frontend surface

The active SPA entry is `src/main.js` and routing lives in `src/App.svelte`.
The unused SvelteKit shell, THORWizard viewer/assets, and music playlist are
recoverable under `archive/` and are excluded from production output. App
Layer, Rapid Swaps, and TC Fee Dash split data/model/chart/presentation work
into focused modules and share terminal alerts and chart tokens.

CI enforces import boundaries, tests frontend and backend domains, checks the
production Svelte surface, and ratchets unreachable-file, source-line, and
public-asset budgets.
