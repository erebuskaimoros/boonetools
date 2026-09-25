<script>
  import { onMount } from 'svelte';
  import { createTimeSeriesChart } from './echarts.js';
  import ChartTools from './ChartTools.svelte';
  import { analysisLegend } from './analytics.js';

  export let points = [];
  export let options = {};
  export let buildOption;
  export let zoomWindow = null;
  export let resetWindow = null;
  export let onZoom = (_window) => {};
  /** @type {((day: string) => void) | null} */
  export let onSelect = null;
  /** @type {((day: string | null) => void) | null} */
  export let onHover = null;
  export let loading = false;
  export let hasData = false;
  export let error = '';
  export let ariaLabel;
  export let loadingText = 'Loading daily history…';
  export let emptyText = 'No daily history is available for this range.';
  export let height = '430px';
  export let narrowHeight = '360px';
  export let historyPoints = [];
  export let onRollingChange = (_ids) => {};
  export let onHiddenChange = (_ids) => {};
  export let onGrainChange = (_grain) => {};
  export let tools = true;
  export let initialGrain = null;
  export let hideUnavailableGrains = false;
  export let showSourceResolution = true;
  let hidden = [], rolling = [], grain = 'day', previousHidden = '', previousSource = '';
  $: baseSpec = buildOption(points, { ...options, hidden: [] })._spec;
  $: historySpec = historyPoints.length ? buildOption(historyPoints, { ...options, hidden: [] })._spec : baseSpec;
  $: sourceGrain = baseSpec?.sourceGrain || 'day';
  $: if (sourceGrain !== previousSource) { grain = initialGrain || sourceGrain; previousSource = sourceGrain; }
  $: if (JSON.stringify(options.hidden || []) !== previousHidden) {
    previousHidden = JSON.stringify(options.hidden || []); hidden = options.hidden || [];
  }
  $: legend = analysisLegend(baseSpec?.series || []);
  $: plotOptions = tools && baseSpec ? { ...options, hidden,
    analysis: { grain, hidden, rolling, baseSpec, historySpec, historyRows: historyPoints } } : options;
  function changeHidden(ids) { hidden = ids; onHiddenChange(ids); }
  function changeGrain(value) { grain = value; onGrainChange(value); }
  function changeRolling(ids) { rolling = ids; onRollingChange(ids); }

  let container;
  let chart;
  let renderError = '';

  function update(points, options, window, resetWindow) {
    if (!chart) return;
    try { chart.update({ points, options, window, resetWindow }); renderError = ''; }
    catch (failure) { renderError = failure.message || 'Chart could not be updated.'; }
  }
  $: update(points, plotOptions, zoomWindow, resetWindow);
  export function resetZoom() { chart?.resetZoom(); }
  export function zoomBy(factor) { chart?.zoomBy(factor); }

  onMount(() => {
    let observer;
    let frame;
    try {
      chart = createTimeSeriesChart(container, { points, options: plotOptions, window: zoomWindow, resetWindow }, {
        buildOption, onZoom: (window) => onZoom(window),
        onSelect: onSelect ? (day) => onSelect?.(day) : null,
        onHover: onHover ? (day) => onHover?.(day) : null
      });
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => chart?.resize());
      });
      observer.observe(container);
    } catch (failure) {
      renderError = failure.message || 'Chart could not be initialized.';
    }
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      chart?.destroy();
      chart = null;
    };
  });
</script>

{#if tools && baseSpec}
  <ChartTools series={legend} {hidden} {rolling} {grain} {sourceGrain} {hideUnavailableGrains} {showSourceResolution} calendar={baseSpec.calendar || 'UTC'}
    onHidden={changeHidden} onRolling={changeRolling} onGrain={changeGrain} />
{/if}
<div class="time-series-frame" aria-busy={loading} style={`--chart-height:${height};--chart-narrow-height:${narrowHeight}`}>
  <div class="echarts-host" bind:this={container} role="img" aria-label={ariaLabel}></div>
  {#if renderError || error || !hasData}
    <div class="chart-message" role="status">{renderError || error || (loading ? loadingText : emptyText)}</div>
  {/if}
</div>

<style>
  .time-series-frame { position: relative; height: var(--chart-height); width: 100%; min-width: 0; }
  .echarts-host { width: 100%; height: 100%; touch-action: pan-y; }
  .chart-message { position: absolute; inset: 0; display: grid; place-items: center; padding: 12px; background: var(--term-surface); color: var(--term-text-3); font: 12px var(--term-font-mono); }
  @media (max-width: 600px) { .time-series-frame { height: var(--chart-narrow-height); } }
</style>
