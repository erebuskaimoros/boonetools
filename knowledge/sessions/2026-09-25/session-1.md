# Session 1 — Shared time-series toolkit production release

> Date: 2026-09-25
> Focus: Merge the accumulated chart work, deploy both components, and close the session.

## Outcome

- Task implementation commit: `6456e84`.
- Merged published main (`47e06d2`) into the isolated task branch and pushed
  `9b80a6e7bec506fc22d3a3597b3397df77dbbcdc` to GitHub main without force.
- [CI verify](https://github.com/erebuskaimoros/boonetools/actions/runs/36141754838)
  passed. Guarded backend and frontend deployments both activated that SHA.
- Primary local main has unrelated unpublished commits and working changes.
  It was not reset, merged, staged, cleaned, or otherwise altered.

## Shipped scope

- Shared ECharts renderer, UTC-date viewport/zoom, escaped swatch tooltips,
  accessible legends, metric-aware selected-range summaries, and feature adapters.
- Common legend toggles, multi-select 7/30/90-day rolling averages, and UTC
  daily/weekly/monthly controls across 30 time-series configurations.
- Preserve native ADR26 epochs by user choice; no fabricated timestamps.
  Coarse-only sources cannot fabricate finer observations.
- Requested card removals on Rapid Swaps, POL TVL, POL deposits, and main
  Financials; Pool Analysis cards remain. Depth/cumulative-fees sliding switch,
  and POL rolling options exclude its cumulative deposit series.
- Cross-chain Competitors title and unavailable-grain/source-note cleanup.
- TC Fee table/Sankey split the post-deduction remainder between bond providers
  and LPs using cached node bonds, liquidity, and current pendulum parameters.
  This is a labeled current-state estimate, not a historical payout.
- Additive comparison daily payload; real calendar-month WASM aggregation.
- Published-main Status provider/freshness and POL live-income recovery fixes
  remain present after the merge.

## Verification and deployment

- Frontend: 445 passed. Backend: 679 passed, 12 database-dependent tests skipped.
- Architecture/surface/Svelte checks passed: zero errors, 56 existing warnings.
- CI and isolated frontend production build passed. Existing dependency and
  bundle warnings were not expanded into unrelated dependency upgrades.
- Backend activation was routine: no migrations or persistent-service restarts.
  Public endpoint gates passed; several unrelated cached read models reported
  staleness warnings. Collector freshness was not represented as fixed by deploy.
- Ran the existing cache-only comparison rebuild under its advisory lock:
  389 daily rows through 2026-09-24, 13 monthly buckets, no source acquisition.
  Monthly JSON SHA-256 remained
  `51652f2d712767710d8fcc7b26e78476978a9729cfba85e21ede7007fd209749`.
- Verified both server release symlinks, active API, enabled comparison timer,
  and public HTML plus 12 relevant hashed JS/CSS assets byte-for-byte against
  the immutable server artifact.
- Production browser verified TC Fee LP table/flow (53.68% bond / 5.32% LP at
  inspection), updated Financials title/layout, monthly default, legend hiding,
  and rolling menu. Comparison finer views are now available from verified
  daily data. Temporary QA tab closed; user's dev tab remained untouched.

## Papercut review

Resolved by adding a versioned development guide, correcting AGENTS worktree
path guidance, and documenting both dependency installations. Verified the
guide links, actual deploy/test commands, and installed backend dependency:

- `pc-20260924-171113-870353`
- `pc-20260923-014649-a4e1be`
- `pc-20260922-235855-636fb2`
- `pc-20260922-225011-7373b5`
- `pc-20260921-200354-971da0`
- `pc-20260920-140349-27af99`
- `pc-20260918-130522-f4d0f0`
- `pc-20260922-222336-d66e94`
- `pc-20260910-005448-86ee20`

50 entries remain open. The bounded review deferred external browser/provider
conditions and independent product work. In particular, SSH session failures
were not reproduced with this release's reused connection; historical provider
queries need separately verified archive behavior. Existing
`pc-20260918-121824-4f8934` (harmless macOS archive metadata warnings) recurred;
changing the already-verified deployment machinery was left for separate work.
`pc-20260910-072507-6a9a5c` (durable dev cache under node_modules) needs a
separate storage migration; no reinstall touched this running dev worktree.

## Remaining work

The requested merge/deploy is complete. Renderer standardization remains an
incremental project: nine Chart.js integrations and the native event views
remain intentionally supported by the shared controls. No new background
monitoring was created; normal production timers continue.
