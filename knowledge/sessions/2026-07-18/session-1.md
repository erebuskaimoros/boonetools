# Session 1 - BooneTools Performance Correction

> Date: 2026-07-18
> Focus: Move dashboard provider work off-request, deploy durable read models, and enforce production performance budgets

## Summary

Reworked the high-traffic BooneTools dashboards around compact durable Postgres read models so public GET requests no longer fan out to THORNode, Midgard, Dune, or RPC providers. Added isolated publishers, bounded detail paths, response caching/compression, and rollback-protected performance gates, then deployed the backend and frontend to production and verified every corrected dashboard endpoint against freshness, size, compression, and latency budgets.

## Work Done

- Added the `api_read_models` and `api_read_model_runs` schema, read-path indexes, deterministic ETags, freshness metadata, run retention, and a three-second single-flight row cache.
- Published compact Status, Treasury, Rapid Swaps, Node Votes, App Layer, and TC Fee models through independently scheduled and locked jobs.
- Removed request-time provider fan-out and duplicated browser-side provider/model code; retained bounded cursor routes for drill-down data.
- Added weighted rate limiting, per-route concurrency limits, JSON response timing/size logs, `Server-Timing`, and Caddy zstd/gzip compression.
- Hardened deployment with writer quiescing, backend/shared/systemd/Caddy snapshots, rollback restoration, dependency-ordered priming, and timer startup only after public smoke checks pass.
- Added a production performance harness that rejects stale, non-JSON, uncompressed, oversized, non-2xx, or over-budget dashboard responses.
- Fixed a production-discovered deploy snapshot bug by skipping optional systemd units that are not installed.
- Fixed Rapid market-history fallback by splitting Midgard ranges into sequential requests of at most 400 intervals when Dune is unavailable.
- Upgraded the backend `ws` dependency to 8.21.1 after the deployment audit identified its memory-exhaustion advisory; the production dependency audit is now clean.
- Deployed migrations 027-028, the backend services/timers, Caddy compression, and the matching frontend bundle.
- Verified 131 frontend tests, 138 backend tests, zero Svelte errors, the production build, migration chain, shell/Node syntax, and live production budgets.

## Discoveries

- Dune query `7620035` exhausted its configured billing-cycle datapoint limit and returned HTTP 402; the durable market-history publisher must remain functional through Midgard alone.
- Midgard rejects ranges wider than 400 intervals. The Apr 1 to Jul 18 hourly bootstrap succeeds as seven bounded Liquify requests; the configured secondary hostname was also temporarily failing DNS.
- Optional systemd unit paths must be existence-checked before rollback snapshots even when Bash `nullglob` is enabled, because literal missing paths are not removed by glob expansion.
- Performance release gates should run from the production host against the public origin. This exercises Caddy and the complete app path without conflating application latency with an arbitrary client's DNS/TLS distance.
- The previous public paths were materially expensive: representative legacy responses reached megabytes and multi-second provider latency; the deployed compact routes returned 1.9-154 KB compressed and 6-31 ms in the production smoke pass.

## Files Changed

| File | Change |
|------|--------|
| `backend/migrations/027_api_read_models.sql` | Added durable read models and publisher run history. |
| `backend/migrations/028_analytics_read_paths.sql` | Added ordered indexes for bounded dashboard detail queries. |
| `backend/src/shared/read-models.js` | Added publication, freshness, retention, ETag, and single-flight read primitives. |
| `backend/src/shared/*read-model*.js` | Added compact dashboard builders and selectors. |
| `backend/src/jobs/*.js` | Added isolated database and provider-backed publishers. |
| `backend/src/handlers/*.js` | Switched corrected public routes to compact DB/read-model reads. |
| `backend/src/shared/rapid-swaps-market-history.js` | Added incremental retention and bounded Midgard fallback chunking. |
| `backend/package.json`, `backend/package-lock.json` | Upgraded `ws` to the patched 8.21.1 release. |
| `src/lib/*.svelte`, `src/lib/*/api.js` | Switched dashboards to one backend request path and removed duplicate provider work. |
| `shared/status/`, `shared/treasury/` | Centralized runtime-neutral status and Treasury domain models. |
| `ops/systemd/boonetools-*.{service,timer}` | Added independent publisher schedules and deadlines. |
| `ops/caddy/Caddyfile.boone.tools` | Enabled zstd/gzip API compression. |
| `scripts/deploy-boonetools-backend.sh` | Added rollback snapshots, strict quiescing, ordered priming, and release gates. |
| `scripts/perf-smoke.mjs` | Added production latency, payload, freshness, content-type, and compression checks. |
| `docs/performance-architecture.md` | Documented the read-model architecture and operational budgets. |
| `backend/tests/`, `tests/` | Added read-model, job isolation, deploy safety, API contract, and frontend regressions. |

## In Progress

None - the performance correction is deployed and verified. Provider quota and publisher freshness remain operational monitoring items.

## Next Steps

- [ ] Monitor `api_read_model_runs`, timer failures, and stale-response headers through the next full day.
- [ ] Restore or raise the Dune datapoint allowance for query `7620035`; keep Midgard as the tested fallback.
- [ ] Compare production response latency and compressed payloads over a longer traffic window.
