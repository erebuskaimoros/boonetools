<script>
  import RangeSummary from '../charts/RangeSummary.svelte';
  import { PROTOCOLS } from '../../../shared/protocol-fee-comparison/model.js';
  import TimeSeriesChart from '../charts/TimeSeriesChart.svelte';
  import { buildComparisonTimeSeries } from './time-series.js';

  export let months = [];
  export let hidden = [];
  export let daily = [];
  let zoomWindow = null;
  $: points = daily.length ? daily : months.map(row => ({ ...row, day: row.fromDay }));
</script>

<RangeSummary rows={points} window={zoomWindow} bucket={daily.length ? 'day' : 'month'} metrics={PROTOCOLS.map(protocol => ({
  label: protocol.label + ' net income', kind: 'flow', unit: 'usd',
  value: row => daily.length ? row[protocol.id]?.netUsd : row.protocols?.[protocol.id]?.complete ? row.protocols[protocol.id].netUsd : null
}))} note="After token subsidy. Only covered source buckets count. Totals and averages follow the selected range; calendar edges may be partial." />
<TimeSeriesChart {points} options={{ hidden, sourceGrain: daily.length ? 'day' : 'month' }} buildOption={buildComparisonTimeSeries}
  hideUnavailableGrains showSourceResolution={false}
  {zoomWindow} onZoom={value => zoomWindow = value} initialGrain="month" hasData={points.length > 0} height="390px" narrowHeight="340px"
  ariaLabel="Swap income less network token subsidy for THORChain, NEAR Intents, and Chainflip. Signed USD. Daily, weekly, or monthly buckets when daily source data is available." />
