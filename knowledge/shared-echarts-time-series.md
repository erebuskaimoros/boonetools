# Shared ECharts time series

## Status — September 22, 2026

September 23 follow-up: removed the four per-chart summary cards and their
coverage captions from all six Rapid Swaps overview plots by user request.
The top-level dashboard stats and D/W/M, legend, and rolling-average controls
remain unchanged. POL TVL also omits its four chart-summary cards and their
coverage caption by user request; its dashboard stats, cursor values, inspection
selector and chart controls remain unchanged. Other dashboards retain their
summary cards. POL Tracker's deposit chart retains just total and average,
without minimum/maximum cards; the two retained cards fill the summary row.

September 25 follow-up: the main Financials plot omits its duplicate summary
strip; the page headline cards and protocol-comparison summary remain. POL
deposit rolling options include only daily deposits, retaining the cumulative
line and its legend toggle. Pool Analysis switches Depth/Cumulative Fees with
a keyboard-accessible sliding switch, preserving the selected dates and zoom.

The competitor section is titled Cross-chain Competitors. It hides unavailable
D/W buttons and its source-resolution note on monthly-only payloads; daily-capable
payloads can still expose D/W/M. Other toolbars keep their existing disclosure.
TC Fee Dash now splits the residual income between bond providers and LPs using
current cached pendulum inputs; see `knowledge/tc-fee-dash.md`.

Implemented on `feat/shared-echarts-time-series`, based on main `7265d0b`.
Not committed, merged or deployed by this task. Financials already uses
ECharts in production; this pass moves it onto a common foundation and
replaces the Burn Tracker and Pool Analysis Chart.js renderers. The second
pass migrates Rapid Swaps' six overview charts and both System Income POL
charts (deposits and expandable daily fees).
The third pass migrates App Layer's five charts and POL TVL's stacked area.

The [feature-group survey](time-series-standardization-groups-2026-09-10.md)
still defines the migration scope. There are now **17 chart configurations
across seven dashboards** using one foundation: the four interactive mixed
charts, Rapid's six compact overviews, POL's newer daily-fee overview, and
the six composition/alternate-view charts.
The daily-fee chart was added after the original 28-chart survey, so this is
not “17 of 28.” This is not yet a completed sitewide switchover.

## Sitewide controls — September 23, 2026

All **30 primary time-series configurations** now share clickable HTML legends,
a per-metric 7/30/90-day multi-select rolling menu, and calendar D/W/M controls.
This is a control/analytics rollout, not completion of the renderer migration.
The protocol comparison is now the 18th shared ECharts configuration; nine
Chart.js configurations use a compatibility toolbar and three event/SVG charts
retain their native views alongside a shared ECharts calendar view.

- `ChartTools.svelte` supplies keyboard buttons, pressed visibility state,
  independent average checkboxes, Escape/outside dismissal and source-resolution
  notices. Hiding every primary series is allowed. Average overlays remain
  independent; unused axes disappear without changing selected-range totals.
- `analytics.js` is renderer-independent calendar math. Features explicitly
  select sum for flows, last observation for stocks/cumulative values, arithmetic
  mean, or a feature-owned weighted reducer. Weeks begin Monday; months use real
  UTC boundaries. Rapid's legacy local-day fallback retains its labeled calendar.
- Full consecutive observed daily windows are required for rolling averages.
  Zeros count, null/missing days are gaps, and partial days are not extrapolated.
  On W/M plots an average is sampled at the last observed day in the bucket;
  it remains a **daily** average, not a mean of weekly/monthly totals. The UI says
  so. TC and affiliate weighted-rate/halt-exclusion rules stay feature-owned.
- `TimeSeriesChart` automatically installs controls from the feature descriptor,
  with explicit reducers and optional full-history lookback. Pool and Financials
  lazily fetch existing all-history reads without changing the displayed range.
  Burn and POL reuse loaded full history. Sparse short histories cannot provide
  a 90-day curve before sufficient observations exist.
- `LegacyChartTools` / `legacy-analytics.js` preserve Chart.js raw datasets,
  tooltip callbacks, linked windows, annotations and drill-downs. Feature models
  still perform their weighted D/W/M aggregation. WASM adds true calendar months;
  its hourly option remains under Native. Legacy 30/90/180 controls are replaced.
- `EventTimeSeriesChart` / `event-calendar.js` provide Native plus calendar views
  for block intervals, pool dislocation and bond churns. Verified event dates
  are grouped into observed days; no forward-filled balances or missing samples
  are invented. Block intervals are block-count weighted, deviations are sampled
  means, and bonds use last observed churn balances. Native references, event
  markers and intra-day zoom remain intact. Choosing a daily average switches
  Native to calendar view.
- **ADR26 pair history remains in native epochs by user choice.** Its legend
  works; D/W/M and daily averages are explicitly unavailable without verified
  epoch timestamps. No block-time estimate was introduced.
- Protocol comparison's additive backend `daily` field exposes the same derived
  daily accounting and common verified cutoff as the existing monthly payload.
  Existing collectors/caches require no migration or new source calls. Old
  snapshots without this field stay monthly-only with disabled D/W/rolling
  controls. Deploying the backend and publishing its next snapshot enables
  those finer views. This task has not deployed anything.
- Source-only weekly App Layer fallbacks cannot be reconstructed into daily or
  calendar-month buckets. The controls disclose/disable unavailable resolutions.
  Categorical charts, Sankeys, watchlist sparklines, navigation accessories,
  archived briefings and the dev-only candle panel are not calendar-bucket charts.

Verification: pure reducer tests (leap months, Monday weeks, weighted means,
closing stocks, gaps, partial edges and lookback), real ECharts zoom/visibility
transitions, Chart.js compatibility tests, existing domain suites and focused
backend collector tests. Desktop browser checks cover Financials, TC Fee Dash,
Status, Pool Dislocation, all five WASM controls, ADR26's epoch exception and
its affiliate D/W/M/average controls, and Pool Analysis. Final verification:
406 frontend tests and 26 focused backend tests pass; production build passes;
Svelte check stays at 0 errors / 56 existing warnings. Bond remains covered by
source/model wiring, not a newly supplied address-dependent live fixture.
Preview reads public snapshots only; no production acquisition or deployment.

Earlier sections below record the preceding migration passes. This section
supersedes their Pool-only control and 17-chart renderer counts.

## Selected-range summaries — September 22, 2026

All **30 primary time-series configurations** now have a reusable four-card
summary strip, including the 12 still on legacy Chart.js/SVG and the standalone
monthly protocol comparison. This does not change the 17-chart shared-renderer
migration count. Sparklines, navigator accessories, categorical/Sankey charts,
static briefings and the development-only candle panel remain outside this scope.

- `charts/RangeSummary.svelte` renders four flush cards above the plot, 4/2/1-up
  according to container width. Full-precision values are available as titles.
- `charts/summary.js` handles finite observations, inclusive UTC-day selection,
  and visible-index selection for the affiliate Chart.js zoom. Missing values
  are excluded, zero counts, signed flows remain signed, and no buckets are
  invented. Counts and partial/provisional metadata explain each denominator.
- One flow: total/mean/min/max; two flows: total/mean for each. One stock/rate:
  mean/min/max/latest; two: mean/latest each. Three/four primary metrics use
  secondary mean/latest values to keep all series visible within four cards
  (three metrics add a selected-bucket count). Latest never carries a missing
  end-of-window value forward. Hidden overlays do not alter the primary metrics.
- Pool Analysis uses periodic volume/fees, independent of its cumulative/depth
  overlay and table period. App Layer uses periodic fields even in cumulative
  view and preserves its explicit activity-gap zero policy. Rapid ignores seeded
  cumulative baselines. POL TVL and Bond summarize balances, never their sums.
- Financials preserves completed-day averages while including partial days in
  totals, matching its existing headline accounting. Its explicit
  `averageFilter`/`averageBasis` is optional; other flows average the selected
  available buckets, including partial buckets without extrapolation.
- Block intervals preserve the existing block-count-weighted mean via custom
  cards. Wasm rates and per-bucket quantiles use explicitly labeled arithmetic
  means, not whole-window weighted rates/quantiles. Monthly protocol net income
  uses only covered buckets and displays each protocol's denominator.
- Legacy coordinated windows continue to own slicing. Affiliate drag zoom
  reports category bounds; reset and chart reconstruction clear that selection.
  No new fetching, backend changes, or data normalization was introduced.

Verification for this pass: summary math and adapter/adoption regression tests;
Pool desktop/mobile and keyboard zoom/reset; App Layer cumulative/zoom and
preserved plot heights; Financials existing/new mean agreement and monthly
comparison; TC/Wasm, POL TVL, affiliate native drag/reset and epoch summaries.
The preview consumes public snapshots only. Bond's address-dependent history
is covered by source wiring, not a newly supplied live wallet fixture.

## Implemented contract

Pool Analysis now places a multi-select **ROLLING AVGS** disclosure next to the
legend: independent 7/30/90-day volume and fee lines, blue/amber with
solid/dashed/dotted strokes. Its +/− zoom buttons are removed; drag, pinch,
double-click and Reset Zoom remain. Averages are trailing arithmetic means of
daily USD amounts, including the ending day, and need a complete consecutive
UTC window. Zeros count; gaps remain null; partial windows are flagged without
extrapolation. The feature lazily reads/caches the existing all-history endpoint
for off-screen lookback, leaving the selected range, zoom and summaries alone.
Base bars and averages toggle independently and share their metric's axis.
The renderer only gains an explicit `lineType` descriptor; acquisition and
rolling calculations stay in `pool-analysis/`. No backend changes are required.

- `charts/TimeSeriesChart.svelte`: one mounted Canvas instance; updates via
  `setOption`; element ResizeObserver; loading/empty/render-error messages;
  feature-provided accessible description and height; observer/frame/event
  cleanup on unmount. Refreshes with existing data keep the plot visible.
- `charts/time-series.js`: pure calendar-bucket mixed/overview/composition options. Explicit axis
  IDs, labels, positions, colors, value formatters, zero/signed/automatic baseline,
  optional numeric bounds and integer ticks;
  explicit series IDs, bar/line marks, axis association, values and bounded
  styling choices, including stack IDs, line area fills and per-day zero/missing status
  markers. No general deep-merge/opaque ECharts override API.
- `charts/SeriesLegend.svelte`: static keys or keyboard-operable HTML buttons
  with `aria-pressed`. Financials keeps its last-visible-series protection;
  Burn retains independent toggles, including the optional price series;
  Pool's legend toggles each series and its axis, with keyboard support and
  matching tooltip rows; toggling preserves the viewport and summary cards.
  Visibility persists across range/line-metric changes and pool selection.
- `charts/viewport.js` and `charts/controller.js`: sorted, unique UTC calendar
  days; inclusive `{ startDay, endDay }`, with `null` meaning the full current
  dataset/follow latest. Native marquee and inside/pinch zoom, no wheel
  interception; reset, double-click reset and optional `zoomBy(factor)`.
  An optional `resetWindow` restores a feature's current preset instead of all
  history (App Layer's default is 30 days, including overlapping weekly buckets).
  Updates and resizing retain dates, not relative percentages. If a rolling
  dataset retires a boundary, the parent receives the actual clamped window.
- Overview mode (`zoom: false`) has no brush toolbox or inside zoom. Compact
  density suppresses axis names and reserves less margin. Its optional
  `onSelect(day)` callback covers blank day slots as well as bars; keyboard
  inspection remains feature-owned HTML. It is not yet a zoom + drill-down
  gesture arbitration contract.
- Optional `onHover(day | null)` links HTML values to the nearest category,
  including zero/gap days and original day identities after zoom. POL TVL
  provides a native day selector for equivalent keyboard inspection.
- Shared terminal axes, adaptive right-axis spacing, non-animated rendering,
  11px minimum axis/legend text, 12px escaped HTML tooltips with square swatches.

Adapters remain beside their feature models. They supply values and metadata;
the foundation does not fetch, calculate, aggregate, interpolate or rebase them.
Source errors/staleness and retry actions remain in the parent dashboards.
Range/unit/metric toolbars remain feature-owned, rather than imposing one
toolbar or adding new capabilities to every chart.

## Preserved feature semantics

| Feature | Preserved behavior |
| --- | --- |
| Financials | Blue volume / green income / amber APR, three axes; USD/RUNE; existing range presets and viewport summaries/table; linked dashed partial APR segment without bridging a missing day; one APR tooltip row and source details. Same-range refresh, including a new UTC day, keeps custom zoom. |
| Burn Tracker | Orange daily bars / amber all-time anchored cumulative line / optional dashed blue RUNE price; historical USD conversion before range slicing; 30D/90D/180D/all, default 90D; missing prices and partial-day styling; stream/poll updates retain zoom and visibility; accessible daily table unchanged. |
| Pool Analysis | Blue volume / amber generated fees / green cumulative fees or two-sided depth; exact fee/volume BPS and RUNE detail; null depth gaps, observed-depth timestamps and partial/missing flags; 30D/all; keyboard zoom controls; independent table-period filters; chart data acquisition remains lazy. |
| Rapid Swaps | Six daily overview charts; seeded cumulative volume/count on independent explicitly bounded axes; HTML visibility controls for both mixed charts; green/amber filled efficiency lines, yellow/red adoption bars; null adoption values, executed-leg volume and existing date inputs unchanged. UTC backend buckets and the legacy local-day fallback retain their own dates and are explicitly labeled. Categorical and Sankey plots remain Chart.js. |
| System Income POL deposits | Green daily bars / amber cumulative line; independent zero-based axes, RUNE/USD, range presets, marquee/double-click reset and new keyboard zoom buttons; full-history RUNE fallback and historical USD totals prepared before range selection. Missing prices stop cumulative USD. Live heads and currency/refresh updates preserve date zoom. |
| System Income POL fees | Daily rather than cumulative fees; historical price, coverage/seeded/provisional explanations, amber dashed provisional bars, × for missing and — for known zero. No zoom. Pointer tooltips and tap-to-pin remain; a labeled native day selector provides keyboard access instead of focusable SVG hit targets. Escape, outside click, repeat tap, Dismiss or unit/range change clears the pinned details. |
| App Layer (five charts) | Independent daily/weekly, bars/cumulative, 30D/all and visibility state. Retained 01 + generated 03 bars stack; Reserve settlement and POL accrual remain separate. Historical values, cutover allocation, settlement/denom details and full-history cumulative anchors are unchanged. Feature preparation preserves existing activity-gap zero fill/cumulative carry. Mode/grain/preset commands reset only that chart; refresh keeps custom dates; reset and double-click restore the selected preset. Native zoom buttons and visible-window accessible descriptions. |
| POL TVL | Four same-height stock snapshots, never sums across time; static legend values follow hover or a native inspection selector. Missing/negative lower valuations suppress upper stack layers. Zero layers break their own fill/outline but allow valid positive layers above; missing totals remain unavailable. Range presets, refresh-retained zoom, marquee/double-click reset and native zoom controls; live System Income POL headline remains separate from completed-day history. |

## Small adapter recipe

Use a feature-owned model to prepare sorted, unique `YYYY-MM-DD` rows, full
cumulative baselines and null/partial metadata before range slicing. Never
parse a display label back into a date. The standard interactive domain is
UTC days; Rapid's non-zooming legacy fallback explicitly labels local days.

```js
import { buildTimeSeriesOption, timeSeriesTooltip } from '../charts/time-series.js';
import { TERMINAL_CHART_PALETTE as palette } from '../charts/terminal.js';

export function buildDailyOption(rows, { width = 1000, window = null } = {}) {
  return buildTimeSeriesOption(rows, {
    width, window,
    axes: [{
      id: 'fees', label: 'FEES · USD', position: 'left',
      color: palette.amber, format: value => '$' + value.toLocaleString('en-US')
    }],
    series: [{
      id: 'fees', label: 'DAILY FEES', mark: 'bar', axis: 'fees',
      color: palette.amber, data: rows.map(row => row.feesUsd)
    }],
    tooltip: row => timeSeriesTooltip([
      row.day + ' · UTC',
      { id: 'fees', color: palette.amber,
        text: 'FEES: ' + (row.feesUsd === null ? 'unavailable' : '$' + row.feesUsd) }
    ])
  });
}
```

```svelte
<TimeSeriesChart points={rangeRows} buildOption={buildDailyOption}
  {zoomWindow} onZoom={(window) => zoomWindow = window}
  hasData={rangeRows.length > 0} {loading}
  ariaLabel="Daily fees in USD by UTC day" />
```

For a compact, non-zooming chart, pass `zoom: false, compact: true` to the
builder and explicitly set the host height. Add `SeriesLegend` when useful.
Keep the host mounted while a viewport falls out of a rolling dataset so its
controller can clamp and report the dates. Range/unit/grain choices and
keyboard data access belong to the feature; the shared layer never infers them.

Composition recipe: set the same `stack` ID on related series; use `areaFill`
on line series for stacked areas. Feature models must mask invalid stack bases
and decide whether zero has an outline. `pol-tracker/model.js` demonstrates
the distinction; do not copy its valuation-gap policy into activity charts.
App Layer's `Chart.svelte` demonstrates independent control state, full-history
rows with a preset viewport, and `resetWindow`. Its five configurations share
one wrapper/adapter instead of five renderer implementations. Use the actual
selected source grain, not a requested daily grain that fell back to weekly.

## Verification

- `npm test`: 394 tests passed, including the pre-existing financial/model
  coverage and new shared viewport/tooltip/controller/feature-adapter tests.
- Real ECharts SVG model exercises the mixed adapters through zoom, append,
  metric/visibility change, resize, reset and disposal. Tests protect zero vs
  null, immutable inputs, all-time cumulative anchors, provisional segments,
  missing depth, tooltip escaping and sparse/empty/single-day windows. New
  tests exercise overview mode without implicit zoom, per-day selection,
  all-missing fee markers, Rapid seeded values/axis bounds/area fills,
  local-calendar provenance, and POL live-head/currency viewport retention.
  Pool rolling tests cover off-screen lookback, missing calendar dates, warmup,
  zeros, fresh partial overrides, independent axes, and real ECharts series
  addition/removal without changing the selected UTC window. Browser checks
  cover all six selections, Space/Escape, wrapped dropdown layout, tooltip
  values/partial labels, independent bar toggles and drag-zoom retention.
- `npm run check`: boundary/surface checks pass; zero Svelte errors and 56
  existing warnings (no ratchet regression). `npm run build` passes.
- Local browser preview reads the published `/functions/v1` snapshots through
  a local proxy; no acquisition jobs or production writes. Burn and Pool
  checked at desktop and 390px: drag/keyboard zoom, price/line controls,
  double-click reset, all-time Pool history and tooltip swatches. Financials
  also checked at both sizes: zoom updates its summary/table; hiding APR and
  manual refresh preserve the selected dates; RUNE and 1Y selection work.
  All three fit a 390px viewport without document overflow; no browser errors
  observed. Native physical-device pinch gestures are not device-tested.
- Second pass: all six Rapid charts render with live public read-model data;
  legend keyboard toggle, tooltip values/swatches, date-input change,
  distribution and Sankey tab round-trips checked. POL deposit keyboard zoom,
  currency switch and manual refresh keep the selected dates; daily fees show
  seeded/provisional details via keyboard and tap, and Escape dismisses.
  Both dashboards checked at 390px, including tooltip confinement and wrapped
  zoom/reset controls. No chart errors or document overflow observed. The
  backend's existing Rapid source-degraded banner is retained, not concealed.
- Third pass: real ECharts SVG tests verify stacked area fill/outline segments
  across zeros and missing values, upper-layer bases, independent App Layer
  windows, periodic/cumulative series replacement, signed flows, weekly
  overlap, full-history anchors, current-preset reset and hover after zoom.
  Desktop and 390px browser checks cover all six canvases, App Layer grain/view
  switches and independent refresh-retained windows, keyboard legend/zoom,
  repeated active-preset reset, POL inspection/hover, marquee/double-click and
  confined square-swatch tooltips. No document overflow or chart errors.

Install both frontend and backend dependencies in a fresh worktree before
running repository checks: `npm ci` and `npm ci --prefix backend`. The boundary
check imports backend configuration even for a frontend-only change.

## Remaining adoption

1. Analytical/coordinated views: explicit overlays, annotations, linked
   windows, navigator and drill-down contracts.
2. Block/churn/epoch histories: separate timestamp/ordered-event domains,
   never falsely regularized to calendar days.

The monthly protocol comparison remains on its existing ECharts adapter. It
still needs an explicit monthly-bucket contract; signed axes alone do not
complete that migration. Sankeys,
categorical charts, candles, sparklines and static briefing plots are untouched.
Chart.js stays installed until its remaining consumers have been migrated.
