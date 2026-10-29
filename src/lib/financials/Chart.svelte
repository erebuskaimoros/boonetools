<script>
  import TimeSeriesChart from '../charts/TimeSeriesChart.svelte';
  import ChartTools from '../charts/ChartTools.svelte';
  import { analysisLegend, analysisRollingSeries } from '../charts/analytics.js';
  import { buildFinancialEChartsOption, buildFinancialHourlyOption, buildFinancialChartOption } from './echarts-options.js';

  export let points = [];
  export let historyPoints = [];
  export let onRollingChange = (_ids) => {};
  export let currency = 'usd';
  export let hidden = [];
  export let zoomWindow = null;
  export let loading = false;
  export let hasData = false;
  export let onZoom = (_window) => {};
  export let onSelect = (_day) => {};
  export let grain = 'day';
  export let onGrainChange = (_grain) => {};
  let lineMetric = 'runePriceUsd';
  let rolling = [];
  $: hourly = grain === 'hour';
  $: baseSpec = (hourly ? buildFinancialHourlyOption(points, { currency }) : buildFinancialEChartsOption(points, { currency, lineMetric }))._spec;
  $: historySpec = historyPoints.length && !hourly ? buildFinancialEChartsOption(historyPoints, { currency, lineMetric })._spec : baseSpec;
  $: options = { currency, hidden, lineMetric, bucket: hourly ? 'hour' : 'day', selectWithZoom: !hourly,
    ...(!hourly ? { analysis: { grain, hidden, rolling, baseSpec, historySpec, historyRows: historyPoints } } : {}) };
</script>

<ChartTools series={analysisLegend(baseSpec.series)} rollingSeries={analysisRollingSeries(baseSpec)}
  {grain} {hidden} {rolling} sourceGrain={hourly ? 'hour' : 'day'} showSourceResolution={false} showRollingControls={!hourly}
  grains={['hour', 'day', 'week', 'month']} availableGrains={['hour', 'day', 'week', 'month']}
  onGrain={onGrainChange} onHidden={value => hidden = value} onRolling={value => { rolling = value; onRollingChange(value); }}>
  <svelte:fragment slot="legend-extra">{#if !hourly}<button class="line-switch" role="switch" aria-label="Show bonding APR instead of RUNE price" aria-checked={lineMetric === 'bondingApr'}
    on:click={() => lineMetric = lineMetric === 'bondingApr' ? 'runePriceUsd' : 'bondingApr'}>
    <span class:active={lineMetric === 'runePriceUsd'}>RUNE PRICE</span>
    <span class="track" aria-hidden="true"><span class="thumb"></span></span>
    <span class:active={lineMetric === 'bondingApr'}>BONDING APR</span>
  </button>{/if}</svelte:fragment>
</ChartTools>
<TimeSeriesChart {points} {options} buildOption={buildFinancialChartOption} tools={false} {zoomWindow} {loading} {hasData} {onZoom}
  onSelect={(day) => { if (grain === 'day') onSelect(day); }}
  ariaLabel={`${hourly ? 'Hourly' : 'Daily'} THORChain volume and system income bars, plus ${!hourly && lineMetric === 'bondingApr' ? 'bonding APR' : 'RUNE price in USD'} on three independent axes. Use the day picker below for daily top swaps and pools.`}
  emptyText={hourly ? 'Hourly history is loading; saved observations will appear as they arrive.' : 'No protocol history is available for this range.'} />

<style>
  .line-switch { display: inline-flex; align-items: center; gap: 8px; min-height: 34px; padding: 4px 0; border: 0; background: transparent; color: var(--term-text-3); font: 11px var(--term-font-mono); cursor: pointer; }
  .active { color: var(--term-accent); }
  .track { position: relative; width: 36px; height: 18px; box-sizing: border-box; border: 1px solid var(--term-accent); border-radius: 2px; }
  .thumb { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; background: var(--term-accent); transition: transform .15s ease; }
  [aria-checked=true] .thumb { transform: translateX(18px); }
  button:focus-visible { outline: 2px solid var(--term-accent); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .thumb { transition: none; } }
</style>
