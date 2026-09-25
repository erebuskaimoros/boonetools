<script>
  // Compatibility toolbar for analytical charts still using Chart.js. Their
  // existing feature models continue to own bucket math and drill-down windows.
  import ChartTools from './ChartTools.svelte';
  import { createLegacyChartAnalytics } from './legacy-analytics.js';
  export let chart = null;
  export let rows = [];
  export let historyRows = [];
  export let metrics = [];
  export let grain = 'day';
  export let sourceGrain = 'day';
  export let allowNative = false;
  export let onGrain = (_grain) => {};
  let hidden = [], rolling = [], series = [];
  const render = createLegacyChartAnalytics();
  $: series = render(chart, rows, historyRows, metrics, hidden, rolling);
</script>

<ChartTools {series} {hidden} {rolling} {grain} {sourceGrain} {onGrain} {allowNative}
  onHidden={(ids) => hidden = ids} onRolling={(ids) => rolling = ids} />
