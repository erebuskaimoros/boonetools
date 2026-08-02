# Session 2 - Status Block Production Chart

> Date: 2026-07-21
> Focus: Add and deploy a 24-hour THORChain block-production chart to the status dashboard

## Summary

Added a materialized 24-hour block-production history lane to the BooneTools
status dashboard and deployed it to production. The chart now renders real RPC
block-header samples above Stuck Transactions without adding provider work to
the public request path; the production status read model remains compact,
fresh, and performance-gated.

## Work Done

- Added migration 029 for durable block-production samples with a 48-hour retention window.
- Added a shared RPC transport and preserved the node-vote archive-specific provider order through its wrapper.
- Added hourly historical bootstrap sampling and five-minute live block-time averages to the status scheduler.
- Published a bounded 150-point block series through status schema v2 and covered the full-window payload budget in tests.
- Added a responsive terminal SVG with latest, weighted average, maximum, observed-block metrics, a six-second target, and point tooltips.
- Corrected the status dashboard width calculation so the chart fits beside the navigation sidebar.
- Hardened the App Layer and Status deploy prime steps with three bounded retries after two rollbacks caused by transient provider DNS failures.
- Deployed backend migration/services and frontend assets, then verified the live chart and production performance budgets.

## Discoveries

- Provider-backed one-shot systemd primes can fail on a brief Liquify request plus an unresolved deprecated fallback; immediate reruns succeeded, so deploy-level bounded retries prevent unnecessary full rollbacks while retaining final failure safety.
- The existing status container used `100vw`, which ignored the sidebar and clipped the right edge at common desktop widths; sizing against the content container fixes the whole status surface.
- A 20-block sample at hourly historical anchors produces a useful low-cost 24-hour view, while five-minute live samples steadily replace bootstrap points without increasing browser latency.

## Files Changed

| File | Change |
|------|--------|
| `backend/migrations/029_block_production_samples.sql` | Added durable block-production sample storage and index |
| `backend/src/shared/block-production.js` | Added RPC header parsing, historical bootstrap, live sampling, retention, and history loading |
| `backend/src/shared/rpc.js` | Extracted the reusable THORChain RPC fallback client |
| `backend/src/shared/node-votes.js` | Routed node-vote RPC calls through the shared transport with archive-first URLs |
| `backend/src/jobs/status-dashboard-scheduler.js` | Collected and published block history alongside existing status lanes |
| `backend/src/shared/status-dashboard.js` | Advanced the materialized status schema to v2 |
| `shared/status/model.js` | Added compact/downsampled block-production contract fields |
| `src/lib/status/BlockProductionChart.svelte` | Added the responsive terminal SVG chart |
| `src/lib/StatusDashboard.svelte` | Positioned the chart, updated source attribution, and corrected container sizing |
| `backend/tests/block-production.test.js` | Covered RPC parsing and block-range calculations |
| `backend/tests/status-dashboard.test.js` | Covered compact output, full 24-hour span, and payload budget |
| `backend/tests/analytics-jobs.test.js` | Covered retry-hardened production prime steps |
| `scripts/deploy-boonetools-backend.sh` | Added bounded retries for transient provider-heavy primes |
| `scripts/frontend-surface-baseline.json` | Synchronized the checked public-byte baseline |
| `knowledge/status-dashboard.md` | Documented block history architecture and failure behavior |

## In Progress

None - session complete and deployed.

## Next Steps

- [ ] Monitor five-minute live samples as they replace the hourly bootstrap points over the next 24 hours.
- [ ] Watch status publisher freshness and the new sample table retention during normal timer operation.
- [ ] Investigate or replace the intermittently unresolved THORNode fallback hostname if DNS failures continue.
