# Session 2 - Site-wide Readability Pass

> Date: 2026-07-30
> Focus: Readable typography, contrast, chart text, and responsive presentation across BooneTools

## Summary

Completed a site-wide readability overhaul across every routed BooneTools page,
including both briefing reports and the development-only Limit Orders surface.
The shared design system, page-scoped styles, canvas charts, SVG charts, and
mobile layouts now use brighter text and explicit size floors while preserving
the terminal aesthetic. The verified frontend release is live on BooneTools.

## Work Done

- Audited all live routes at desktop and 390px mobile widths, combining rendered
  text-size/contrast checks with visual inspection.
- Raised essential labels, controls, metadata, table headers, and chart axes to
  at least 11px; body copy now starts at 13-14px and chart tooltips at 12px.
- Rebuilt the shared terminal text ramp so even its dimmest permitted text token
  remains readable on canonical dark surfaces; brightened semantic error red.
- Replaced page-scoped `#222`-`#777` text literals and private dim variables with
  the shared readable text tokens across every routed page.
- Fixed chart-specific bypasses in Chart.js, Sankey, KLineChart, custom canvas
  plugins, responsive SVGs, and generated briefing assets.
- Prevented Status and Pool Dislocation SVG labels from shrinking on narrow
  screens by retaining a readable intrinsic width with horizontal scrolling.
- Regenerated all SS dynamic-fee briefing chart copies with 14px base labels,
  16px headings, and 13px metadata.
- Corrected mobile-only regressions discovered during the visual pass, including
  12px ledes, Dynamic Fees status sublabels, and a TC Fee total that split in the
  middle of the dollar value.
- Updated the design contract so future work reserves 10px type for decorative
  indices and glyphs rather than essential content.
- Verified 165/165 frontend tests, zero project-check errors, a clean production
  build, and a clean whitespace diff.
- Deployed frontend release
  `3032b363ea4d3b3bb9df10e687c7ad17b130ea7b` through the guarded atomic release
  workflow and verified the homepage, Status, TC Fee, Pool Dislocation, App
  Layer, and Rapid Swaps routes in production.

## Discoveries

- Most routed pages used component-scoped color literals, so improving global
  tokens alone could not materially improve the site. Scoped page styles had to
  be migrated explicitly.
- Canvas and externally loaded SVG text bypass normal CSS. Shared Chart.js
  defaults help, but Sankey labels, KLineChart, custom plugins, and generated SVG
  assets still require local typography contracts.
- A readable SVG font declaration is insufficient when a 1000-1200px viewBox is
  squeezed into a narrow container; preserving intrinsic chart width is part of
  the typography contract.
- The previous semantic error red (`#dc3545`) fell just below normal-text AA
  contrast on the terminal background. The new error token is intentionally
  brighter.
- Ten-pixel text remains useful for decorative indices, flow arrows, and compact
  provenance markers, but not for controls, data labels, or explanatory copy.

## Files Changed

| File | Change |
|------|--------|
| `DESIGN.md` | Replaced the dim/small-text guidance with explicit readability and chart typography floors. |
| `docs/style.md` | Synchronized the long-form style guide with the brighter token ramp and type scale. |
| `src/lib/styles/variables.css` | Added the shared readable text/type ramp and brighter legacy text/error tokens. |
| `src/lib/styles/base.css` | Added consistent line-height and shared component typography rules. |
| `src/App.svelte` | Loaded the shared tokens globally and enlarged/brightened shell navigation and status text. |
| `src/lib/StatusDashboard.svelte`, `src/lib/status/BlockProductionChart.svelte` | Enlarged dashboard, table, timeline, tooltip, and SVG text; retained readable mobile chart width. |
| `src/lib/RapidSwaps.svelte`, `src/lib/rapid-swaps/chart-renderer.js` | Improved page, axes, legends, tooltips, and explicit Sankey labels. |
| `src/lib/TCFeeDash.svelte`, `src/lib/tc-fee-dash/charts.js` | Improved controls/chart text and prevented mobile metric-value splitting. |
| `src/lib/PoolDislocation.svelte` | Raised all essential UI/chart labels, brightened state text, and added mobile chart scrolling. |
| `src/lib/BondTrackerV2.svelte` | Raised form, metric, history, table, chart, and status typography. |
| `src/lib/VaultExplorer.svelte`, `src/lib/Treasury.svelte` | Raised dense explorer, mosaic, position, table, badge, and provenance text. |
| `src/lib/DynamicFeeDashboard.svelte` | Raised controller, affiliate, transaction, table, pill, and chart typography. |
| `src/lib/NodeVotes.svelte` | Replaced the private dim ramp and raised status, filter, table, and detail text. |
| `src/lib/AppLayerBaseLayerDashboard.svelte`, `src/lib/app-layer/charts.js` | Improved flow, metric, chart, table, timeline, note, and control readability. |
| `src/lib/Briefings.svelte`, `src/lib/SsDynamicFeeBriefing.svelte` | Improved index/report navigation, metadata, tables, body copy, and mobile presentation. |
| `scripts/generate-ss-dynamic-fee-charts.mjs`, `docs/ss-dynamic-fee-charts/`, `public/assets/briefings/ss-dynamic-fee-impact/` | Regenerated readable static briefing charts in both canonical locations. |
| `src/lib/LimitOrders.svelte`, `src/lib/limit-orders/ThorchainPairChart.svelte` | Improved the development-only trading UI, KLineChart, and responsive labels. |
| `src/lib/components/ConnectWallet.svelte`, `src/lib/components/CurrencySelector.svelte`, `src/lib/components/CurrencyToggle.svelte` | Raised shared wallet/currency control typography and contrast. |

## In Progress

None - the readability release is deployed and verified in production.

## Next Steps

- [x] Push the validated session revision and wait for GitHub verification.
- [x] Deploy the exact green revision with the guarded frontend release script.
- [x] Verify the production homepage, Status, TC Fee, Pool Dislocation, and App
      Layer routes serve the new hashed assets and readable styles.
- [ ] Monitor user feedback for any dense data surface that would benefit from a
      user-selectable compact/comfortable density control.
