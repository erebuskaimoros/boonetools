<script>
  import { onMount } from 'svelte';
  import { init, use } from 'echarts/core';
  import { PieChart } from 'echarts/charts';
  import { TooltipComponent } from 'echarts/components';
  import { CanvasRenderer } from 'echarts/renderers';
  import { getAssetLogo } from '../constants/assets.js';
  import { allocationShare, buildPolAssetAllocation, buildPolAssetAllocationOption } from './allocation.js';

  use([PieChart, TooltipComponent, CanvasRenderer]);
  export let inventory = [];
  export let loading = false;
  let container;
  let chart;
  let renderError = '';
  $: allocation = buildPolAssetAllocation(inventory);
  $: if (chart) update(allocation);

  function update(next) {
    try { chart.setOption(buildPolAssetAllocationOption(next), { notMerge: true }); renderError = ''; }
    catch { renderError = 'Chart unavailable. Holdings are listed alongside.'; }
  }

  onMount(() => {
    let observer;
    let frame;
    try {
      chart = init(container, null, { renderer: 'canvas' });
      update(allocation);
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => chart?.resize());
      });
      observer.observe(container);
    } catch { renderError = 'Chart unavailable. Holdings are listed alongside.'; }
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      chart?.dispose();
      chart = null;
    };
  });
</script>

<div class="allocation" aria-busy={loading}>
  <div class="chart-column">
    <div class="plot">
      <div bind:this={container} class="pie-chart" role="img" aria-label="Current POL asset allocation by USD value. Amounts and shares are listed alongside."></div>
      {#if renderError || !allocation.hasValue}
        <p class="chart-message" role="status">{renderError || (loading ? 'Loading holdings…' : 'No priced holdings available.')}</p>
      {/if}
    </div>
    <p class="allocation-total"><span>{allocation.incomplete ? 'PRICED HOLDINGS' : 'TOTAL HOLDINGS'}</span><strong>{allocation.hasValue ? allocation.totalLabel : '—'}</strong></p>
  </div>
  <div class="allocation-key">
    <div class="key-heading" aria-hidden="true"><span>ASSET / AMOUNT HELD</span><span>USD VALUE / SHARE</span></div>
    <ul aria-label="POL asset amounts and allocation shares">
      {#each allocation.assets as asset (asset.asset)}
        <li>
          <span class="swatch" style:background-color={asset.color} aria-hidden="true"></span>
          <div class="asset-info">
            <span class="asset-name" title={asset.asset}><img src={getAssetLogo(asset.asset) || '/assets/coins/fallback-logo.svg'} alt="" aria-hidden="true" />{asset.label}</span>
            <span class="asset-amount">{asset.amountLabel} {asset.ticker}</span>
          </div>
          <div class="asset-share"><strong>{asset.valueLabel}</strong><span>{allocationShare(asset.percent)}</span></div>
        </li>
      {/each}
    </ul>
    <p class="allocation-note">Slices show USD value, not token amounts.{#if allocation.incomplete} Unpriced assets are excluded from the pie and percentages.{/if}</p>
  </div>
</div>

<style>
  .allocation { display: grid; grid-template-columns: minmax(240px, .8fr) minmax(0, 1.2fr); align-items: center; gap: 24px; padding: 16px 24px; container-type: inline-size; }
  .chart-column, .allocation-key { min-width: 0; }
  .plot { position: relative; width: 100%; max-width: 360px; height: 290px; margin: auto; }
  .pie-chart { width: 100%; height: 100%; touch-action: pan-y; }
  .chart-message { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; padding: 20px; background: var(--term-surface); color: var(--term-text-3); text-align: center; font: 12px/1.5 var(--term-font-mono); }
  .allocation-total { display: flex; justify-content: center; align-items: baseline; flex-wrap: wrap; gap: 8px 12px; margin: 0 0 6px; }
  .allocation-total span, .key-heading { color: var(--term-text-3); font: 600 11px/1.4 var(--term-font-mono); letter-spacing: .05em; }
  .allocation-total strong { color: var(--term-text); font: 700 20px/1.4 var(--term-font-mono); }
  .key-heading { display: flex; justify-content: space-between; gap: 12px; padding: 0 0 10px; border-bottom: 1px solid var(--term-border); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--term-border-faint); }
  .swatch { width: 10px; height: 10px; }
  .asset-info, .asset-share { display: grid; gap: 5px; min-width: 0; }
  .asset-name { display: flex; align-items: center; gap: 7px; color: var(--term-text); font: 600 12px/1.4 var(--term-font-mono); }
  .asset-name img { width: 16px; height: 16px; object-fit: contain; }
  .asset-amount, .asset-share span { color: var(--term-text-3); font: 12px/1.4 var(--term-font-mono); overflow-wrap: anywhere; }
  .asset-share { text-align: right; }
  .asset-share strong { color: var(--term-text); font: 600 12px/1.4 var(--term-font-mono); }
  .allocation-note { color: var(--term-text-3); font: 12px/1.5 'DM Sans', sans-serif; margin: 12px 0 0; }
  @container sipol (max-width: 650px) {
    .allocation { grid-template-columns: 1fr; gap: 20px; padding: 12px 16px 16px; }
    .plot { height: 250px; }
    .key-heading { font-size: 11px; letter-spacing: 0; }
    li { gap: 8px; }
  }
</style>
