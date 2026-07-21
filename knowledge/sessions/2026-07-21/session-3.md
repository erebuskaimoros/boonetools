# Session 3 - Block Chart Tooltips

> Date: 2026-07-21
> Focus: Add and deploy accessible tooltips for the status block-production chart

## Summary

Replaced the block-production chart's native SVG title hints with a consistent
terminal-styled tooltip and deployed the interaction to production. Every point
now exposes its timestamp, block time, observed-block count, and block height
through pointer, touch, focus, and keyboard interaction.

## Work Done

- Added an in-chart tooltip with a guide line and highlighted point anchor.
- Clamped the tooltip horizontally and moved it below high points so it remains inside the responsive SVG.
- Expanded each point's invisible hit target without changing the chart's visual density.
- Supported hover, focus, click/touch, Enter, Space, and Escape interactions.
- Added button semantics and descriptive ARIA labels for keyboard and assistive-technology users.
- Deployed the frontend and verified the live tooltip against the 14.3-second production spike.

## Discoveries

- Native SVG `<title>` hints are browser-dependent and do not provide a consistent terminal presentation or dependable touch behavior.
- SVG focus was not reliably retained after pointer activation, so an explicit click/touch selection state is needed alongside focus and hover state.
- Rendering the tooltip inside the SVG keeps positioning aligned through responsive scaling and page scrolling without translating browser coordinates.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/status/BlockProductionChart.svelte` | Added accessible, responsive terminal tooltips to every chart point |

## In Progress

None - session complete and deployed.

## Next Steps

- [ ] Reuse this SVG interaction pattern for future BooneTools time-series charts where point-level detail is useful.
- [ ] Monitor touch and keyboard behavior across production browsers as the chart accumulates live samples.
