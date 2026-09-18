<script>
  import { onMount } from 'svelte';
  import { createFinancialECharts } from './echarts.js';

  export let points = [];
  export let currency = 'usd';
  export let hidden = [];
  export let zoomWindow = null;
  export let loading = false;
  export let hasData = false;
  export let onZoom = (_window) => {};

  let container;
  let chart;
  let renderError = '';

  $: if (chart) chart.update({ points, currency, hidden, window: zoomWindow });

  onMount(() => {
    let observer;
    let frame;
    try {
      chart = createFinancialECharts(container, { points, currency, hidden, window: zoomWindow }, (window) => onZoom(window));
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => chart?.resize());
      });
      observer.observe(container);
    } catch (error) {
      renderError = error.message || 'The financials chart could not be initialized.';
    }
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      chart?.destroy();
      chart = null;
    };
  });
</script>

<div class="preview-frame" aria-busy={loading}>
  <div class="echarts-host" bind:this={container} role="img" aria-label="Daily THORChain volume and system income bars, plus bonding APR on three independent axes. Uses the series, range and currency controls. Daily values are in the table below."></div>
  {#if renderError || loading || !hasData}
    <div class="preview-message" role="status">{renderError || (loading ? 'Loading daily history…' : 'No protocol history is available for this range.')}</div>
  {/if}
</div>

<style>
  .preview-frame { position: relative; height: 430px; width: 100%; min-width: 0; }
  .echarts-host { width: 100%; height: 100%; }
  .preview-message { position: absolute; inset: 0; display: grid; place-items: center; background: var(--term-surface); color: var(--term-text-3); font-family: var(--term-font-mono); font-size: 12px; }
  @media (max-width: 600px) { .preview-frame { height: 360px; } }
</style>
