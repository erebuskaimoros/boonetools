# Financials: ECharts comparison

Historical prototype notes below. ECharts was subsequently selected and shipped
for Financials on September 18; the renderer-selection query parameters are no
longer needed. For the September 22 shared-foundation follow-up, see
[shared ECharts time series](shared-echarts-time-series.md).

Development-only prototype, September 10, 2026. This is not a decision to migrate the site.

## Open the comparison

With the existing Vite development server running, open `/financials?charts=compare` (both charts) or `/financials?charts=echarts` (ECharts initially). The development-only renderer switch offers Chart.js, ECharts, or Both. The original production route still uses Chart.js; the ECharts component is dynamically imported only inside an `import.meta.env.DEV` guard.

The two plots share the same fetched rows, range/currency/series controls, selected UTC-day window, summary cards, and daily table. Zooming either renderer updates the shared window. Switching renderer preserves it; range/currency changes follow Financials' existing reset behavior. Same-day refreshes retain the selected window.

## Prototype boundaries

- ECharts 6.1.0, with selective core/bar/line/grid/tooltip/inside-zoom/toolbox/Canvas imports. No framework wrapper, backend changes, or new endpoint.
- Same blue volume, green income, amber APR, three independent axes, and bar/line drawing order.
- Missing values remain missing. The live APR segment is a separate dashed series linked to the APR toggle; it never bridges an unavailable prior APR day. Tooltip content retains the cutoff and provisional-estimate explanation.
- Tooltips use escaped HTML with square series-color swatches: outlined translucent blue/green for the bars and solid amber for APR. Swatches follow shared series visibility; metadata remains unmarked, and provisional APR still appears only once.
- External HTML controls remain shared. ECharts additionally exposes its native selection/undo icons. Its axis tick selection and straight line interpolation differ from Chart.js' current slight curve.
- This is a feature-local experiment, not the proposed reusable time-series module yet. Domain models and accounting were not moved into the renderer.

## Checks

Browser checks in the local app covered both-renderer display, switching, shared drag zoom, reset, USD/RUNE, hiding/restoring APR and its axis, live-day tooltip, and desktop/390px layouts. Temporary viewport overrides were reset. Native pinch gestures were not device-tested.

Focused tests cover units, axes/colors/order, null versus zero, input immutability, partial APR gaps, visibility, inclusive day windows, zoom payload conversion, tooltip metadata, and font/layout configuration. An actual ECharts SSR model test covers live-update window preservation and full reset. Existing financial-model and legend tests are retained.

After the tooltip-swatch addition, 34 focused tests pass. Browser checks confirmed the three swatches, hiding/restoring APR, and the live-day tooltip. Repository checks remain at zero errors / 56 existing warnings.

The normal production build and repository checks pass; existing Svelte diagnostics remain at zero errors / 56 warnings. The production output contains no ECharts renderer chunk or dynamic preview import. Some comparison-shell code/CSS remains after compilation; this prototype does not have literally zero production-byte overhead.

## Bundle comparison

Measured by bundling each complete renderer entry independently with the installed esbuild, browser ESM target ES2022, minification, and Node gzip. These are **standalone compressed entry sizes**, not incremental network transfers within the Vite application, and not rendering-speed benchmarks.

| Renderer entry | Approximate minified size | Approximate gzip size |
| --- | ---: | ---: |
| Chart.js + zoom + Financials adapter | 244 KB | 84 KB |
| ECharts selective imports + Financials adapter | 589 KB | 202 KB |

ECharts is approximately 118 KB larger compressed in this comparison. Native zoom/selection is useful, but bundle size is a meaningful cost. Further adoption should depend on whether richer navigation or linked interactions remove enough custom code to justify it. TC Fee Dash remains a stronger second test for that question than converting more ordinary line/bar charts immediately.

No commit, push, deployment, library-wide migration, or Sankey changes were performed.
