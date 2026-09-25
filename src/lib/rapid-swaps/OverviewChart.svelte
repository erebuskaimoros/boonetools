<script>
  import TimeSeriesChart from '../charts/TimeSeriesChart.svelte';
  import { buildRapidSwapOverviewOption } from './overview-charts.js';

  export let points = [];
  export let metric;
  export let label;
  let hidden = [];
</script>

<TimeSeriesChart {points} options={{ metric, hidden }} buildOption={buildRapidSwapOverviewOption}
  hasData={points.length > 0} ariaLabel={label} height="220px" narrowHeight="220px" />
