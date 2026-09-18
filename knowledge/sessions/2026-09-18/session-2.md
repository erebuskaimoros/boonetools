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

Release verification and production activation are in progress. Production has
no existing comparison records or collector units; import will precede deployment
and timer activation. No unrelated canonical-checkout changes are included.

## Remaining work

- Historical issuance backfills remain incomplete: Chainflip monthly values
  cover August and partial September 2026; NEAR covers January–September 2026
  using the labeled official issuance model until its full on-chain window is
  verified. THORChain covers the full rolling year.
- Verify the seeded database, deployed public API and production chart before
  recording rollout completion.
