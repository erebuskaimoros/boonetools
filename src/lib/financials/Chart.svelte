<script>
  import TimeSeriesChart from '../charts/TimeSeriesChart.svelte';
  import { buildFinancialEChartsOption } from './echarts-options.js';

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
  let lineMetric = 'runePriceUsd';
  let grain = 'day';
</script>

<TimeSeriesChart {points} {historyPoints} {onRollingChange} options={{ currency, hidden, lineMetric, selectWithZoom: true }} buildOption={buildFinancialEChartsOption}
  {zoomWindow} {loading} {hasData} {onZoom}
  onGrainChange={(value) => grain = value} onSelect={(day) => { if (grain === 'day') onSelect(day); }}
  ariaLabel={`Daily THORChain volume and system income bars, plus ${lineMetric === 'bondingApr' ? 'bonding APR' : 'RUNE price in USD'} on three independent axes. Click a day to show its top swaps and pools, or use the day picker below. Weekly and monthly views use the day picker.`}
  emptyText="No protocol history is available for this range.">
  <button slot="legend-extra" class="line-switch" role="switch" aria-label="Show bonding APR instead of RUNE price" aria-checked={lineMetric === 'bondingApr'}
    on:click={() => lineMetric = lineMetric === 'bondingApr' ? 'runePriceUsd' : 'bondingApr'}>
    <span class:active={lineMetric === 'runePriceUsd'}>RUNE PRICE</span>
    <span class="track" aria-hidden="true"><span class="thumb"></span></span>
    <span class:active={lineMetric === 'bondingApr'}>BONDING APR</span>
  </button>
</TimeSeriesChart>

<style>
  .line-switch { display: inline-flex; align-items: center; gap: 8px; min-height: 34px; padding: 4px 0; border: 0; background: transparent; color: var(--term-text-3); font: 11px var(--term-font-mono); cursor: pointer; }
  .active { color: var(--term-amber); }
  .track { position: relative; width: 36px; height: 18px; box-sizing: border-box; border: 1px solid var(--term-amber); border-radius: 2px; }
  .thumb { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; background: var(--term-amber); transition: transform .15s ease; }
  [aria-checked=true] .thumb { transform: translateX(18px); }
  button:focus-visible { outline: 2px solid var(--term-accent); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .thumb { transition: none; } }
</style>
