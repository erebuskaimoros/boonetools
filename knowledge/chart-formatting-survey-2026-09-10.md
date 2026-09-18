# BooneTools chart-formatting survey

Survey date: September 10, 2026, America/New_York. Some browser observations occurred after September 11 began in UTC.

## Conclusion

Build a small chart system, not one universal chart component. Share the visual language and surrounding controls; use separate family modules for time-series plots, categorical plots, Sankeys, and market candles. Keep lightweight SVG and micro-chart adapters where they serve a distinct purpose.

Sankeys are a separate family. Their nodes, links, flow widths, ordering, labels, and categorical colors are not time-series settings. The two existing Sankeys should eventually share a Sankey module, not be routed through a bar/line template.

This is an inventory and recommendation, not an implemented refactor. Application code and existing worktree edits were left untouched.

## Scope and counting

The inventory follows the route registry in [App.svelte][routes], then each reachable page's chart renderers, controls, and models. It includes chart configurations across tabs and conditional states, not just charts visible at initial page load. A reused per-pool chart counts once; dataset choices and range changes do not create additional charts.

| Scope | Primary chart configurations | Breakdown |
| --- | ---: | --- |
| Public navigation | 32 | 28 Chart.js, 4 custom SVG |
| Public direct-route preview: Wasm Arb Economics | 5 | Chart.js; hidden from navigation, not development-gated |
| Public-route total | 37 | 24 Chart.js time/event-series, 7 Chart.js categorical plots, 2 Chart.js Sankeys, 4 SVG plots |
| Development-only Limit Orders | 1 additional panel | KLineCharts; price candles and a volume sub-pane |

Outside that primary count: 8 embedded briefing plots, repeated Pool Dislocation sparklines, the TC Fee Dash canvas range navigator, Vote Tracker value/progress bars, and explanatory HTML flow-of-funds diagrams. These belong in the design inventory but do not all need a full interactive-chart component. Decorative canvas effects and SVG icons are not charts.

The current route list contains 16 public navigation entries; 12 have primary interactive charts. Treasury Tracker, Vault Explorer, Vote Tracker, and Briefings do not add primary interactive charts under the definition above. Briefings and Vote Tracker do have the additional visualizations just noted. Limit Orders adds a seventeenth navigation entry in development.

This is a source-complete inventory of the current checkout's reachable chart configurations, supplemented by local-browser spot checks of Financials, Burn Tracker, TC Fee Dash, Pool Dislocation, Rapid Swaps, and App Layer to Base Layer. It is not an exhaustive interaction/accessibility test or a byte-for-byte audit of the deployed bundle.

## Primary chart inventory

| Page / route | Charts and renderer | Existing controls and interaction | Important differences to preserve |
| --- | --- | --- | --- |
| Network Status / `status` | 1 custom SVG block-interval line/area | Last 24 hours; nearest-point hover; drag selection; reset button; summary statistics follow the visible window | Live per-block updates with repair/fallback history; 6-second reference; adaptive linear y-range; block identity and observed coverage; local-time labels |
| Rapid Swaps / `rapid-swaps` | 14 Chart.js charts: 6 overview, 5 distributions/rankings, 3 paths including a Sankey | Overview / Distributions / Swap Paths tabs; shared start/end date inputs, initially seven local calendar days; selected canvas legends toggle series; affiliate labels open affiliate destinations | UTC daily aggregations versus explicitly local transaction timestamps; cumulative overlays; category ordering; affiliate label hit-testing; source degradation state; Sankey asset identities and flows |
| TC Fee Dash / `tc-fee-dash` | 2 Chart.js historical line/area plots plus 1 Sankey; auxiliary raw-canvas navigator | Day/week/month buckets; 30/90/180-day rolling overlays; shared custom drag window; double-click reset; full-history control; navigator handles and window dragging | Fee-regime point styling; halt bands; weighted ratios and excluded halt days; shared viewport across historical plots; Sankey uses current income-allocation parameters, not that historical viewport |
| Pool Dislocation / `pool-dislocation` | 1 custom SVG signed-deviation plot; repeated SVG watchlist sparklines | 1H/1D/7D presets; oracle/Binance source selection; 1H/6H/1D rolling overlays; HTML series toggles; drag zoom, reset, double-click reset | Signed BPS, zero reference and current minimum-fee corridor; source gaps; rolling coverage requirements; focused pool and watchlist selection; custom crosshair and detailed hover panel |
| Pool Analysis / `pool-analysis` | 1 reused Chart.js mixed chart: volume and fee bars plus cumulative-fees **or** pool-depth line; 3 axes | 30D/all chart ranges; line-metric switch; drag/pinch zoom; reset and double-click reset; explicit zoom-in/out buttons | All chart series USD; table period filters are separate from chart presets; visible-window statistics; missing/partial days and depth-snapshot provenance; static legend rather than series toggles |
| Financials / `financials` | 1 Chart.js mixed chart: volume bars, system-income bars, bonding-APR line; 3 axes | 30D/90D/1Y/all; USD/RUNE; HTML series toggles that also hide axes and retain at least one visible series; drag/pinch zoom; reset | Volume blue, income green, APR amber; explicit dataset drawing order; visible-range metrics and daily rows; incomplete historical bond coverage; live partial-day styling/cutoff; same-day refresh preserves zoom |
| POL TVL / `pol-tvl` | 1 custom SVG stacked area with 4 components | 30D/90D/180D/all, default all; drag zoom, reset, double-click reset; crosshair and HTML tooltip; static legend with hover values | Synth backing, locked Treasury LP, Reserve POL, and system-income POL; completed UTC daily snapshots; missing snapshots break stacks; stock-value summaries are not sums over the selected window; USD chart |
| System Income POL / `pol-tracker` | 1 custom SVG mixed chart: daily gross-deposit bars plus cumulative line; 2 axes | 30D/90D/180D/all; RUNE/USD; drag zoom, reset, double-click reset; crosshair/HTML tooltip; static legend | Live/provisional current-day USD; missing historical prices stop the USD cumulative series; deployment and pool-position tables describe different facts from daily deposits |
| Burn Tracker / `burn-tracker` | 1 Chart.js mixed chart: daily-burn bars, cumulative line, optional RUNE-price line; up to 3 axes | 30D/90D/180D/all, default 90D; RUNE/USD; price toggle; interactive canvas legend plus static footer key; drag/pinch zoom; reset and double-click reset; expandable daily table | Orange daily burns, amber cumulative, blue price; all-time cumulative baseline remains anchored when zoomed; partial-day bars/metadata; unit-dependent price overlay |
| Bond Tracker / `bond-tracker` | 1 Chart.js chart with 2 filled lines: RUNE bond and selected-currency valuation | Currency selection; interactive canvas legend; hover; churn table with CSV/XLS downloads; no date presets or chart zoom | Churn/event-indexed history rather than uniformly spaced daily snapshots; bond-add/remove point and segment colors; last-point value labels; local date display |
| ADR26 Dynamic Fees / `adr26-dynamic-fees` | 2 Chart.js mixed configurations in separate tabs: pair epochs and affiliate history; 3 axes each | Pair selection/epoch drill-down; affiliate range presets, day/week/month grain, rolling overlays, drag/pinch zoom, reset/double-click; interactive canvas legends; click a bucket to inspect transactions | Epoch versus daily/weekly/monthly x-domain; live epoch; selected-bucket highlighting; click-versus-drag intent; volume/fee/rate colors differ between the two tabs; different rate gap handling |
| App Layer to Base Layer / `app-layer-base-layer` | 5 Chart.js frames using one feature-local renderer; periodic bars, stacked accrued-value bars, or cumulative line/area | Each chart independently has daily/weekly, bars/cumulative, 30D/all, drag/pinch zoom, reset; stacked chart legends toggle components | Separate accrued value, retained earnings, Reserve settlements, POL accrual, and generated fees; detailed tooltip breakdowns; accounting cutovers and non-overlap rules; gap filling and cumulative values belong to its model |
| Wasm Arb Economics / `wasm-arb-economics` | 5 Chart.js configurations: value, activity, efficiency, fee/slip behavior, oracle behavior | Shared all/1mo/1w/24h window and 1h/1d/1w grain; drag/pinch zoom; reset/double-click; extracted local ChartControls component | One shared viewport across five plots; stacked retained-value bars; multi-axis ratios; Mimir/milestone annotations; partial buckets; coarser historical source buckets |

Source owners: [Status][status], [Rapid Swaps][rapid], [TC Fee Dash][tc-fee], [Pool Dislocation][dislocation], [Pool Analysis][pool-analysis], [Financials][financials], [POL TVL][pol-tvl], [System Income POL][system-pol], [Burn Tracker][burn], [Bond Tracker][bond], [ADR26][adr26], [App Layer][app-layer], [Wasm][wasm].

### Rapid Swaps: the fourteen configurations

| Group | Individual charts | Appropriate family |
| --- | --- | --- |
| Daily trends | Daily volume + cumulative volume; daily count + cumulative count | Mixed time-series |
| Adoption | Rapid share of network volume; rapid share of network swap count | Time-series bars |
| Execution efficiency | Efficiency ratio; average percent faster | Time-series line/area |
| Distributions | Volume by sub-swap count; swaps by sub-swap count; time-saved histogram | Categorical/distribution |
| Affiliates | Affiliate swap count; affiliate volume | Horizontal ranking, with clickable labels |
| Swap paths | Volume by path; average time saved by path | Horizontal ranking |
| Flow | Asset-to-asset swap-flow Sankey | Sankey |

### Charts outside the public interactive inventory

| Surface | Contents | Treatment |
| --- | --- | --- |
| Limit Orders, development-only | KLineCharts candles plus a volume pane; native zoom, scroll, crosshair, live-candle updates, adaptive precision; 24H/7D/30D/90D/1Y presets tied to candle intervals | Own market-chart adapter. Reuse the frame/tokens, not Chart.js time-series internals |
| TRON performance briefing | 3 fixed SVG charts: monthly swap volume, monthly liquidity fees, top ten pools by fees | Static export style; retain fixed reporting period and alt text |
| SS dynamic-fee briefing | 4 fixed SVG comparisons across curated/uncurated affiliates and one-/six-month periods, with rolling series | Bring the chart-generation script into the same export style; no live-range controls |
| New POL briefing | 1 embedded incentive-pendulum plot image, separate from the cover image | Static reference figure; source/regeneration constraints differ from native charts |
| Pool Dislocation watchlist | Small repeated trend sparklines | Lightweight micro-chart API; no full panel, axes, or range toolbar |
| TC Fee Dash navigator | Overview spark/area on raw canvas with two selection handles | Optional time-window navigator, separate from the primary renderer |
| Vote Tracker and explanatory flow diagrams | HTML value/progress bars and structured flow-of-funds boxes/links | Reusable small visual primitives only where duplication warrants it |

Sources: [Market candles][candles], [Briefings][briefings], [SS briefing renderer][ss-briefing], [POL briefing][pol-briefing], [static chart generator][static-generator].

## What the charts have in common

The majority already use the terminal design language: dark flat backgrounds, thin rules, monospace plot text, restrained green/amber/blue marks, compact numeric axes, a heading with adjacent controls, and hover detail.

The most common *plot* pattern is a time series with bars for periodic amounts and lines for cumulative values or rates. Multiple y-axes are common because units or magnitudes differ. Stacking, percentage series, benchmark lines, and rolling overlays are variations within that family, not reasons to invent a new component each time.

The most common *surrounding UI* is repeated even where the renderer differs:

- Panel heading, explanatory subtitle, and optional source/coverage text.
- Date presets, unit and grain selectors, selected-window text, and reset control.
- Series key/legend, pointer hover, and value formatting.
- Loading, empty, unavailable, stale, and partially observed states.
- Responsive chart sizing and teardown/recreation on page or data changes.

There is an existing foundation in [terminal.js][terminal]: shared colors, font construction, canvas legend interactions, and hidden-series helpers. It is 57 lines, not a shared chart template. Axis styling, tooltips, controls, lifecycle, and viewport state are still mostly local.

The App Layer renderer and Wasm controls already demonstrate useful feature-local reuse. They are starting material for extraction, not drop-in universal solutions: App Layer's renderer currently also performs model-specific gap filling, while Wasm's controls are built around its shared window and source-grain behavior.

## Formatting and interaction drift

| Area | Observed differences | Standardization direction |
| --- | --- | --- |
| Typography | Most Chart.js axes use 11px mono and tooltips 12px; Burn controls are 10px and its footer key 9px; Pool Dislocation tooltip text is 11px; POL TVL tooltip heading is 10px | Enforce documented minimums through shared tokens: essential labels/controls at least 11px, tooltips at least 12px. Do not shrink text to solve mobile layout |
| Colors | Similar roles do not always share colors. ADR26 pair uses blue volume / green fees / amber rate; affiliate uses green volume / amber fees / blue rate. App Layer has additional blue and green shades; POL and Burn use different oranges | Semantic defaults plus explicit chart overrides, with one series descriptor driving mark, axis, legend, and tooltip. Preserve Financials' newly chosen colors |
| Legends | Interactive canvas legends, HTML toggle buttons, static HTML keys, and omitted legends coexist. Burn has both canvas legend and footer key. Financials hides unused axes and protects the last visible series | Common HTML legend/key presentation with explicit `toggle` versus `read-only` behavior. Keep visibility by stable series ID and make axis/last-series policy explicit |
| Tooltips | Dark backgrounds, border shades, heading colors, padding, corners, positioning, crosshairs, and number formats vary. Rich details range from one value to source coverage and accounting breakdowns | Common tooltip typography, spacing, and content structure; renderer-specific positioning and optional feature detail rows |
| Range/reset | Buttons vary between `30D`, `[30d]`, reset wording, disabled/conditional states; double-click exists on some charts but not others. Several charts have no zoom at all | Shared controls for charts that support ranges; always show an accessible reset affordance when relevant. Configure available presets per chart; do not impose time controls on Sankeys or rankings |
| Zoom implementation | Chart.js drag/pinch plugin; hand-built SVG pointer zoom; TC Fee Dash mouse-driven brushing and navigator; KLineCharts native behavior | Common visible-window state contract and control behavior, separate renderer implementations. Touch/keyboard parity should be tested, not assumed from a desktop drag feature |
| Dimensions | Rapid overview canvases are 220px tall in a desktop two-column grid; Financials wrapper 430px; Burn 470px; Pool Analysis 500px. Some SVG charts retain a 680–720px minimum width and scroll on mobile | A few density/height presets with explicit overrides, responsive tick budgets, documented horizontal-scroll behavior for intentionally wide plots |
| Time and units | UTC accounting days coexist with local block/churn/transaction labels. Compact suffixes, decimals, USD/RUNE, percentages, BPS, seconds, and counts are formatted independently | Shared unit-aware formatters; explicit timezone. Default accounting buckets to UTC; label intentional local time without changing bucket boundaries |
| Motion | Financials/Burn/Pool Analysis disable animation; Rapid uses 300ms, ADR26 220ms, Bond 400ms; some renderers leave library defaults | One explicit motion default and reduced-motion policy; allow only deliberate exceptions |
| Refresh/lifecycle | Some charts update existing data; others destroy/recreate instances. Selected range, hover, legend visibility, and live-edge following are not owned consistently | Explicit update policy and state ownership; preserve user window/visibility where intended; clean up listeners, resize observers, and chart instances |
| Accessibility/data access | ARIA labels exist on several canvas/SVG charts but are missing on Rapid canvases. HTML controls can be keyboard-operated; canvas keys and pointer-only custom zoom are different. Data tables/exports are uneven | Shared accessible title/description and controls; series controls in HTML; offer meaningful tabular data where appropriate. Do not claim an ARIA label makes a canvas fully accessible |

These are survey observations, not reproduced product-bug diagnoses. No interaction fixes were attempted.

The written [design contract][design] already establishes much of the desired style. [docs/style.md][style] still primarily provides a copied Chart.js recipe and points to the parent App Layer function, while the renderer now lives in a helper. The cleanup should make those documents point to tested shared primitives rather than a chart to copy.

## Differences that are not formatting problems

These must remain explicit feature-level decisions:

1. **Meaning of a value:** stock, daily flow, lifetime cumulative, rate, signed deviation, block interval, or OHLC candle. They cannot share a universal aggregation rule.
2. **Axis semantics:** one versus three axes; zero-baseline bars; signed deviation references; tightly fitted block intervals; stacked totals. Equalizing axes or forcing zero on every line would change the story.
3. **Missing versus zero:** an unobserved bond day is not zero APR; absent source prices are not zero dollars; some complete event buckets legitimately contain zero. A renderer must not make that decision by default.
4. **Cumulative baseline:** zooming Burn must not rebase all-time burns. Other charts may intentionally show a selected-period cumulative series. Name the policy rather than infer it from the word “cumulative.”
5. **Live completeness:** incomplete day, provisional valuation, partial hour, current epoch, and a forming candle each need different provenance and update behavior.
6. **Viewport ownership:** Financials/Pool Analysis/Status synchronize visible-window statistics; Wasm synchronizes five charts; App Layer owns five independent chart windows; TC Fee Dash combines two historical charts with one navigator. Not every summary card should change when the chart zooms.
7. **Domain interaction:** affiliate links, transaction drill-downs, focused pool selection, Mimir milestones, halt bands, fee corridors, and churn event markers are meaningful extensions.
8. **Sankey topology:** asset flows and protocol allocation both use nodes and weighted links, but their node identity, labeling, ordering, colors, units, and layout constraints differ. Share a flow renderer with explicit configuration, not their data model.

## Proposed module boundaries

These are proposed names/responsibilities, not files introduced by this survey.

| Layer / module | Owns | Does not own |
| --- | --- | --- |
| Shared chart tokens and formatters | Fonts, palette roles, grids, borders, spacing, tooltip style, unit/time display helpers | Feature math, network fetching, gap filling |
| Terminal `ChartFrame`, controls, legend/key | Heading, toolbar slots, source/quality state, responsive shell, accessible actions, legend appearance | A required renderer, mandatory date controls, or a universal tooltip positioning algorithm |
| Time-series family | Bar, line, area, mixed and stacked configurations; axis descriptors; viewport events; Chart.js lifecycle adapter | Accounting aggregation, all-time baselines, live-data collection |
| Categorical family | Vertical distributions, histograms, horizontal rankings, category labels/order and optional click hooks | Time-window zoom assumptions or forced equal category meaning |
| Sankey family | Nodes, links, flow styling/layout, node labels and flow tooltip hooks | Cartesian axes, daily buckets, or time-series gestures |
| Market-chart family | Existing KLineCharts adapter, candles/volume panes, precision, native viewport and live candle behavior | A Chart.js reimplementation |
| Lightweight SVG / micro-chart adapters | Existing specialized SVG plots and small sparklines; shared tokens and optional common viewport helpers | A mandatory full Chart.js dependency or full-sized toolbar |
| Feature data adapters/plugins | Fetching, normalization, coverage, domain aggregation, series definitions, annotations, drill-down callbacks | Copies of global font/grid/tooltip defaults |

Start with a chart specification small enough to read: stable series ID, label, unit, axis, mark type, semantic color/override, drawing order, stack, missing-data policy, and partial-observation metadata. Keep capability flags explicit: toggleable, zoomable, linked viewport, or selectable buckets. Time-based, category-based, and flow-based families should have different data contracts.

A feature should normally customize series and supported capabilities, not copy a 200-line options object. For unusual cases, use a named plugin or renderer override. Avoid an opaque deep-merge configuration that can silently replace callbacks, axes, or interaction state.

The current design document says feature-specific datasets, plugins, and controllers stay beside their models. Preserve that boundary; update the contract deliberately if shared generic viewport/lifecycle helpers are introduced.

## Suggested adoption order

1. **Agree on the visual contract.** Typography, grid/tooltip treatment, panel/toolbar layout, legend interaction, motion, and density presets. Keep semantic color overrides and special chart families explicit.
2. **Pilot the time-series family on Financials and Burn Tracker, then Pool Analysis.** They exercise mixed bars/lines, two/three axes, currency changes, range controls, series visibility, optional series, partial days, and cumulative baselines. Preserve the recent Financials color and layering choices exactly during extraction.
3. **Apply the common frame/tokens more widely.** App Layer is a useful next consumer because it already has five charts on one local factory. Extract reusable presentation without moving its accounting logic into the shared module.
4. **Create the categorical family for Rapid Swaps.** Preserve histogram bins, ranking order, and affiliate-label links. This is not a zoomable time-series migration.
5. **Standardize the two Sankeys together, separately.** Harmonize typography, panel treatment and tooltip styling; keep distinct node/link definitions and configurable layouts.
6. **Integrate the specialized cases incrementally.** TC Fee Dash's shared navigator, Wasm's linked viewport/annotations, ADR26 drill-downs, and SVG charts need explicit compatibility checks. Retain existing renderers until migration offers a clear benefit.
7. **Handle micro-charts and static exports as separate passes.** Market candles are development-only and lower priority. Unreachable legacy code cleanup is a separate task, not a prerequisite for formatting visible charts.

## Verification requirements for the later refactor

Existing tests cover legend helpers, several range/zoom calculations, tooltip details, and feature models. This survey did not find a shared deterministic visual-regression suite for the chart system; the npm scripts currently expose node tests, checks, and a performance smoke test rather than a chart screenshot suite.

Before migrating each pilot, capture fixtures and baseline screenshots. Test:

- Default, hover, hidden series, zoomed/reset, dense/sparse history, loading, empty, error, stale, and partially observed states.
- Desktop and narrow layouts; font floors, tooltip clipping, multi-axis crowding, label overlap, and bar/line drawing order.
- Pointer and keyboard-accessible controls; touch zoom where supported; click-versus-drag drill-down behavior.
- Currency/grain changes; stable legend state; correct axis visibility; refresh preserving a historical viewport unless the user is following live data.
- Missing/null versus zero; no unintended interpolation; weighted ratios; cumulative baselines; same-day/epoch/candle update behavior.
- Linked chart windows and dependent summary values, with explicit independence for charts that do not share a viewport.

Keep the existing feature math tests. A visual standardization is successful only if those meanings remain unchanged.

## Separate house-cleaning observation

The frontend reachability audit passed and reported 136 reachable files and 64 unreachable files (41,450 lines) in the current checkout. Unreachable legacy chart owners include BaseStats, Earnings, RunePool, SaversYield, SolanaProviders, Supply, and ThorchainDominance. They are not counted as charts currently served by the route registry, and nothing was deleted.

That is a useful future cleanup candidate, but deleting it should be a separately scoped review of references, scripts, assets, and any deliberate retention—not part of this chart-formatting survey.

[routes]: ../src/App.svelte
[terminal]: ../src/lib/charts/terminal.js
[design]: ../DESIGN.md
[style]: ../docs/style.md
[status]: ../src/lib/status/BlockProductionChart.svelte
[rapid]: ../src/lib/rapid-swaps/chart-renderer.js
[tc-fee]: ../src/lib/tc-fee-dash/charts.js
[dislocation]: ../src/lib/PoolDislocation.svelte
[pool-analysis]: ../src/lib/pool-analysis/charts.js
[financials]: ../src/lib/financials/charts.js
[pol-tvl]: ../src/lib/POLTracker.svelte
[system-pol]: ../src/lib/SystemIncomePOL.svelte
[burn]: ../src/lib/burn-tracker/charts.js
[bond]: ../src/lib/BondTrackerV2.svelte
[adr26]: ../src/lib/DynamicFeeDashboard.svelte
[app-layer]: ../src/lib/app-layer/charts.js
[wasm]: ../src/lib/wasm-arb-economics/charts.js
[candles]: ../src/lib/limit-orders/ThorchainPairChart.svelte
[briefings]: ../src/lib/Briefings.svelte
[ss-briefing]: ../src/lib/SsDynamicFeeBriefing.svelte
[pol-briefing]: ../src/lib/SystemIncomePolBriefing.svelte
[static-generator]: ../scripts/generate-ss-dynamic-fee-charts.mjs
