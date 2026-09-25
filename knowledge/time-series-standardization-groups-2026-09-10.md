# Time-series standardization: feature groups

## Decision and scope

ECharts is the chosen library for the shared time-series system. Financials and
its monthly protocol comparison shipped with ECharts on September 18. The
September 22 `feat/shared-echarts-time-series` worktree extracts the shared
daily mixed-series foundation and migrates Financials, Burn Tracker, Pool
Analysis, Rapid's six overviews, both System Income POL charts, App Layer's
five charts and POL TVL onto it. The subsequent sitewide controls and competitor
adapter shipped with that foundation in release `9b80a6e` on September 25. See
[implementation status and contract](shared-echarts-time-series.md).

This grouping derives from the [chart survey](chart-formatting-survey-2026-09-10.md). It classifies existing features, not a newly tested implementation. The survey remains the source inventory; this document supersedes its provisional Chart.js time-series adapter recommendation.

The September 10 survey recorded **28 primary time/event-series chart configurations**: then 24 with Chart.js and 4 with SVG. These include the five Wasm Arb Economics charts on a public direct route that is hidden from navigation. Its Financials renderer comparison was an alternative for the same configuration, not another chart in that count. The subsequently added protocol-income comparison and System Income POL's expandable daily-fee chart bring the control rollout to 30 configurations: 18 shared ECharts configurations, nine Chart.js compatibility integrations, and three native event/SVG views with optional ECharts calendar views. The renderer migration is not yet complete.

Excluded from this pass: two Sankeys, seven Rapid Swaps categorical/ranking/distribution plots, development-only market candles, watchlist sparklines, static briefing plots, and HTML progress/flow diagrams. TC Fee Dash's navigator is an accessory to the time-series system, not another primary chart.

## Five primary feature profiles

Each chart is assigned once below for planning. These are overlapping capability profiles, **not five separate chart engines or an inheritance hierarchy**. The detailed capability map identifies which members actually use each feature.

| Profile | Count | Members | Defining features |
| --- | ---: | --- | --- |
| 1. Overview trends | 6 | Rapid Swaps: daily volume, daily count, network volume share, network count share, efficiency ratio, average percent faster | Daily bars and line/area trends; volume/count charts add cumulative overlays and second axes. Shared date inputs; no chart zoom today. Useful for establishing compact chart defaults. |
| 2. Interactive mixed metrics | 4 | Financials, Burn Tracker, Pool Analysis, System Income POL | Periodic bars with cumulative, valuation, or rate lines; two or three independent axes; range presets and zoom. Unit/metric switches, optional series, and dependent summaries vary by member. |
| 3. Composition and alternate views | 6 | POL TVL; App Layer's accrued value, retained earnings, Reserve settlements, POL accrual, generated fees | POL TVL is a four-component stacked stock-value area. The five App Layer charts switch periodic bars to cumulative line/area; accrued-value bars can stack components. App Layer also switches daily/weekly grain. |
| 4. Analytical overlays and coordinated views | 9 | TC Fee Dash's two historical plots; Pool Dislocation; ADR26 affiliate history; Wasm's five plots | Different combinations of rolling overlays, reference regions, event annotations, grain switching, linked windows, and drill-downs. These are optional extensions, not mandatory features of every member. |
| 5. Block, churn, and epoch histories | 3 | Status block production, Bond Tracker, ADR26 pair epochs | Non-uniform block/event/epoch domains. Status has live block timing and a target line; Bond has churn events and bond-change styling; ADR26 has selectable epochs and transaction drill-down. |
| **Total** | **28** | | |

## Capability map

This distinguishes existing features from proposed standard defaults. It does not imply that every chart should gain every capability.

| Capability | Existing consumers | Shared responsibility / boundary |
| --- | --- | --- |
| Bars, lines, and areas | All five profiles in different combinations | Series descriptors choose marks; a common renderer supplies visual defaults. |
| Multiple y-axes and mixed units/magnitudes | Rapid volume/count; Financials; Burn; Pool Analysis; System Income POL; Bond; both ADR26 configurations; several Wasm plots | Explicit axis IDs, units, sides, domains, and series associations. Two USD series may still need independent axes because their magnitudes differ. |
| Stacked components | POL TVL; App Layer accrued-value bars; Wasm retained-value bars | Explicit stack IDs and common tooltip/legend treatment. Stock snapshots and accumulated flows keep distinct model semantics. |
| Currency / valuation selection | Financials, Burn, System Income POL, Bond | Shared selector presentation and unit-aware formatting. Availability, conversion rates, and valuation remain feature-owned. Pool Analysis charts and App Layer remain USD-only. |
| Alternate metric or representation | Pool Analysis cumulative fees versus pool depth; App Layer bars versus cumulative | Shared controls and stable series identity. The renderer does not calculate the new metric or cumulative baseline. |
| Date presets and custom intervals | Most chart pages use presets; Rapid uses shared start/end inputs | Common toolbar and range state, with per-feature choices. Status retains its last-24-hour source window; Bond and pair epochs do not acquire arbitrary date presets by default. |
| Bucket/grain changes | TC Fee Dash; ADR26 affiliate; all five App Layer charts; all five Wasm charts | Shared grain-control presentation and update events. Weighted aggregation, source resolution, and allowed grains stay in feature adapters. |
| Zoom and reset | TC Fee Dash, Pool Dislocation, Pool Analysis, Financials, POL TVL, System Income POL, Burn, ADR26 affiliate, App Layer, Wasm, Status | One viewport contract and accessible reset action. Existing pointer/pinch/double-click support differs; parity must be tested. Rapid, Bond, and ADR26 pair currently have no chart zoom. |
| Explicit zoom-in/out buttons | Pool Analysis | Optional keyboard-operable zoom controls over the same viewport API. |
| Shared zoom window | TC Fee Dash's two historical plots; Wasm's five plots | Controlled viewport shared by the parent. TC Fee Dash's Sankey is not part of its historical window. |
| Independent windows in one dashboard | Five App Layer charts | Each instance owns its own window, despite sharing a renderer. Rapid's common date filter is not linked interactive zoom. |
| Overview navigator | TC Fee Dash | Optional navigator bound to the shared historical viewport; not a requirement for every time series. |
| Rolling overlays | TC Fee Dash: 30/90/180 days; Pool Dislocation: 1/6/24 hours; ADR26 affiliate: 30/90/180 days | Reusable series/toggle styling. Calculations, coverage thresholds, and weighting remain outside the renderer. |
| Reference lines, bands, and event annotations | Status's six-second target; Pool Dislocation's zero reference and fee corridor; TC Fee Dash's halt bands and fee-regime points; Wasm's milestones; Bond's change events and final values | Named annotation types and extension hooks. Feature code supplies values, labels, and event meaning. |
| Bucket selection and drill-down | ADR26 pair epochs and affiliate history | Stable selected-bucket ID and callback. Distinguish clicks from zoom drags; transaction fetching stays in the page. |
| Visible-window summaries / detail rows | Status statistics; Financials metrics and daily data; Pool Analysis detail statistics | Emit the selected domain window. Feature models decide what is recomputed. Do not turn POL TVL's stock summaries into sums over the viewport. |
| Partial or provisional observations | Financials; Burn; Pool Analysis; System Income POL valuation; ADR26's live epoch; Wasm partial buckets | Common quality indicators, dashed/dimmed marks where configured, and tooltip detail slots. Different completeness meanings must remain explicit. |
| Live/incremental updates | Particularly Status's per-block stream and Financials' current day; other pages have their own polling/update cadence | Update without silently losing visibility or a historical window; make follow-latest behavior explicit. Network polling and repair logic remain feature-owned. |
| Series visibility | Interactive legends in selected Rapid charts, Financials, Burn, Bond, ADR26, stacked App Layer charts, and Wasm; Pool Dislocation's HTML toggles; other pages use specific overlay controls or static keys | A common HTML legend supports toggle or read-only mode. Axis hiding, linked APR segments, and last-visible-series protection are explicit policies. |
| Detailed hover information | All families, with differing depth | Shared tooltip shell, square series-color swatches, unit formatting, and metadata sections. Coverage, accounting breakdowns, and source explanations remain feature-provided. |

## Shared foundation versus feature-owned behavior

The shared system should have one ECharts time-series renderer, a terminal-style frame/toolbar/legend, and a small set of optional capabilities. Profiles provide useful defaults; they do not replace explicit configuration.

The common visual contract covers:

- Monospace typography and minimum readable font sizes, grid/border treatment, and density/height presets.
- One series definition driving plot color, matching axis, legend, and tooltip swatch.
- Common range/reset/visibility controls, tooltip layout, loading/empty/error/stale states, and accessible descriptions.
- Resize and teardown behavior; stable IDs; update behavior that preserves user state when intended.
- Explicit x-domain and timezone: timestamp, calendar bucket, or ordered event/epoch. Do not silently replace event spacing with daily buckets or change local labels into different accounting boundaries.

Optional capabilities are multi-axis layout, stacking, zoom/reset, a controlled shared window, navigator, overlay toggles, annotations, and bucket selection. A chart opts into what it needs; it should not pass an unrestricted copy of ECharts options for ordinary customization.

Keep these out of the shared renderer:

- Fetching, aggregation, weighted rates, rolling calculations, and currency conversion.
- Null-versus-zero decisions, missing-data interpolation, and source coverage thresholds.
- Stock-versus-flow semantics and cumulative baselines, including Burn's all-time anchor.
- Which summary cards follow a viewport, source-resolution constraints, and transaction drill-down queries.

The four SVG time-series plots in the original survey are in scope by function, not excluded because of their renderer. Migrate them only after their particular behavior is represented: block-stream timing for Status, signed corridor/coverage for Pool Dislocation, stacked missing snapshots for POL TVL, and provisional currency/cumulative gaps for System Income POL. Their small watchlist sparklines remain outside this pass.

## Suggested implementation sequence

Steps 1–3 are implemented and locally verified in the September 22 worktree;
steps 4–5 remain. This sequence is a migration plan, not a production status
claim; see the linked implementation note for current verification.

1. **Extract the foundation from Financials, then prove it on Burn and Pool Analysis.** Cover mixed marks, independent axes, currency/metric controls, swatch tooltips, visibility, zoom, partial days, and cumulative baselines. The accepted Financials colors and drawing order are fixtures, not a new palette decision.
2. **Apply the basics to Rapid's six overview charts and System Income POL.** Exercise compact panels and a simpler two-axis consumer without introducing advanced analytical extensions.
3. **Add composition and alternate-view capabilities with App Layer and POL TVL.** Verify independent chart windows, stack gaps, periodic/cumulative modes, and stock-value semantics.
4. **Add linked navigation with TC Fee Dash, then Wasm.** This is the main proving ground for the expected ECharts interaction benefit. Add rolling/annotation support as explicit capabilities.
5. **Complete specialized interaction/domain cases:** Pool Dislocation's signed corridor and coverage, ADR26 affiliate/pair drill-downs, Bond's churn styling, and Status's live per-block behavior. Do not force these into the daily-accounting data contract.

Before each migration, retain domain tests and capture fixtures for default/hover/hidden/zoomed/partial/missing states. Verify desktop and narrow layouts, keyboard controls, touch interactions where supported, refresh preservation, and click-versus-drag behavior. The original September 10 grouping was planning only; the implementation status above records subsequent local work.

## September 23 control rollout

All 30 primary time-series configurations now share the clickable legend and
7/30/90D rolling-menu contract with D/W/M source-aware bucket controls. ADR26
pair epochs are an explicit user-approved native-domain exception. Event charts
retain Native views; old monthly/weekly-only snapshots disable unsupported finer
or incompatible buckets. This does not complete renderer migrations in steps 4–5:
legacy analytical charts adopt a shared compatibility toolbar. See
[implementation details](shared-echarts-time-series.md#sitewide-controls--september-23-2026).
