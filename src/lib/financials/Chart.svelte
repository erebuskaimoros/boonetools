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
</script>

<TimeSeriesChart {points} {historyPoints} {onRollingChange} options={{ currency, hidden }} buildOption={buildFinancialEChartsOption}
  {zoomWindow} {loading} {hasData} {onZoom}
  ariaLabel="Daily THORChain volume and system income bars, plus bonding APR on three independent axes. Uses the series, range and currency controls. Daily values are in the table below."
  emptyText="No protocol history is available for this range." />
