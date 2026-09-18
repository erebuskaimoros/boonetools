<script>
  import { onMount } from 'svelte';
  import { init, use } from 'echarts/core';
  import { BarChart } from 'echarts/charts';
  import { GridComponent, TooltipComponent, MarkLineComponent } from 'echarts/components';
  import { CanvasRenderer } from 'echarts/renderers';
  import { comparisonOption } from './options.js';
  use([BarChart, GridComponent, TooltipComponent, MarkLineComponent, CanvasRenderer]);
  export let months = [];
  export let hidden = [];
  let host, chart;
  function draw() { if (chart) chart.setOption(comparisonOption(months, hidden, host.clientWidth), { notMerge: true }); }
  $: if (chart && months && hidden) draw();
  onMount(() => {
    chart = init(host, null, { renderer: 'canvas' }); draw();
    const observer = new ResizeObserver(() => { chart.resize(); draw(); }); observer.observe(host);
    return () => { observer.disconnect(); chart.dispose(); chart = null; };
  });
</script>

<div class="chart" bind:this={host} role="img" aria-label="Monthly swap income less network token subsidy for THORChain, NEAR Intents, and Chainflip. Signed USD values use one scale and are available in the monthly data table."></div>

<style>
  .chart { width: 100%; height: 390px; }
  @media (max-width: 600px) { .chart { height: 340px; } }
</style>
