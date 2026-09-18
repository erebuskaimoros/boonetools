# Session 2 — Financials ECharts and protocol comparison rollout

> Date: 2026-09-18
> Focus: Publish the updated Financials dashboard and seed production before acquisition starts.

## Work done

- Isolated the dashboard changes from the dirty canonical checkout in the
  `feat/financials-echarts-release` worktree based on current production main.
- Promoted the chosen ECharts renderer to production and retained the monthly
  THORChain / NEAR Intents / Chainflip subsidy-adjusted comparison.
- Added an offline, transactional, insert-only seed exporter, retaining local
  acquisition checkpoints, observation timestamps and explicit data gaps.
- Added bootstrap safety tests and deployment endpoint health coverage.

## Release status

CI-green `a98dd7e` was published to main and deployed to the backend. The
production seed transaction committed at 16:00:23 UTC, before timer activation
at 16:00:53 and the first collector run at 16:02:53. It contains 382 days,
383 CF boundaries, 201 NEAR epochs and 52 CF issuance days. Public monthly data
exactly matched the seed. By 16:03:40 the collector had resumed to 211 epochs.

The isolated frontend build then caught a dev-plugin import of backend-only
configuration (`dotenv`). The old frontend remained live. A failing regression
test reproduced the import leak; the request transport is now runtime-neutral,
with backend metrics/cooldown hooks injected only by the production job.
Frontend-only build verification and the corrected rollout are in progress.
No unrelated canonical-checkout changes are included.

## Remaining work

- Historical issuance backfills remain incomplete: Chainflip monthly values
  cover August and partial September 2026; NEAR covers January–September 2026
  using the labeled official issuance model until its full on-chain window is
  verified. THORChain covers the full rolling year.
- Verify the seeded database, deployed public API and production chart before
  recording rollout completion.
