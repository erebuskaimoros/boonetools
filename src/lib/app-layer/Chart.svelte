<script>
  import RangeSummary from '../charts/RangeSummary.svelte';
  import TimeSeriesChart from '../charts/TimeSeriesChart.svelte';
  import { utcDayIndices } from '../charts/viewport.js';
  import { appLayerPresetWindow, appLayerSeries, appLayerSummaryMetrics, buildAppLayerOption, prepareAppLayerChart } from './charts.js';

  export let pick;
  export let chartKey;
  export let view = 'bars';
  export let range = '30d';
  export let onZoom = (_active) => {};
  export let loading = false;
  export let loadingText;
  export let emptyText;
  export let ariaLabel;

  let host;
  let hidden = [];
  let customWindow = null;
  let custom = false;
  let previousControls = '';
  $: points = prepareAppLayerChart(pick, chartKey);
  $: presetWindow = appLayerPresetWindow(points, range, pick.grain);
  $: syncControls(chartKey, pick.grain, view, range);
  $: zoomWindow = custom ? customWindow : presetWindow;
  $: bounds = utcDayIndices(points, zoomWindow);
  $: plotLabel = ariaLabel + (points.length
    ? `. Visible ${points[bounds.start].day} through ${points[bounds.end].day}; ${pick.grain} UTC buckets.` : '');
  $: options = { key: chartKey, grain: pick.grain, view, hidden };
  $: legend = appLayerSeries(chartKey, view).map(item => ({
    id: item.id, label: item.label, color: item.colors.mark, mark: item.mark
  }));

  function syncControls(key, grain, chartView, chartRange) {
    const controls = [key, grain, chartView, chartRange].join(':');
    if (controls === previousControls) return;
    previousControls = controls;
    custom = false;
    customWindow = null;
    onZoom(false);
  }
  function zoomChanged(window) {
    const current = utcDayIndices(points, window);
    const preset = utcDayIndices(points, presetWindow);
    customWindow = window;
    custom = current.start !== preset.start || current.end !== preset.end;
    onZoom(custom);
  }
  function toggle(id) {
    hidden = hidden.includes(id) ? hidden.filter(item => item !== id) : [...hidden, id];
  }
  export function resetZoom() { host?.resetZoom(); }
</script>

<div class="app-layer-chart">
  <div class="chart-tools">

    <div class="zoom-controls">
      <button aria-label="Zoom in" on:click={() => host?.zoomBy(0.65)} disabled={points.length < 2}>[+]</button>
      <button aria-label="Zoom out" on:click={() => host?.zoomBy(1.5)} disabled={points.length < 2}>[−]</button>
    </div>
  </div>
  <RangeSummary rows={points} window={zoomWindow} metrics={appLayerSummaryMetrics(chartKey)} bucket={pick.grain === 'weekly' ? 'week' : 'day'} {loading}
    note="Periodic values, including known empty activity buckets; never sums of the cumulative line." />
  <div class="plot">
    <TimeSeriesChart bind:this={host} {points} {options} buildOption={buildAppLayerOption}
      {zoomWindow} resetWindow={presetWindow} onZoom={zoomChanged}
      {loading} hasData={points.length > 0} {loadingText} {emptyText} ariaLabel={plotLabel}
      height="310px" narrowHeight="310px" />
  </div>
</div>

<style>
  .app-layer-chart { height: auto; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .chart-tools { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; }
  .zoom-controls { display: flex; gap: 6px; margin-left: auto; }
  button { border: 1px solid var(--term-border); background: var(--term-surface); color: var(--term-text-3); font: 11px var(--term-font-mono); padding: 4px 6px; cursor: pointer; }
  button:focus-visible { outline: 1px solid var(--term-info); outline-offset: 2px; }
  button:disabled { opacity: .5; cursor: default; }
  .plot { min-width: 0; }
</style>
