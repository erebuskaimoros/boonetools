<script>
  import RangeSummary from '../charts/RangeSummary.svelte';
  import { PROTOCOLS } from '../../../shared/protocol-fee-comparison/model.js';
  import TimeSeriesChart from '../charts/TimeSeriesChart.svelte';
  import { buildComparisonTimeSeries, selectComparisonView } from './time-series.js';

  export let months = [];
  export let hidden = [];
  export let daily = [];
  export let nearNetSupply = false;
  export let thorchainRewardAccounting = false;
  let zoomWindow = null;
  let selectedMode = null;
  // Choose once after data arrives. A background refresh must not override the
  // user's scope, grain, legend choices or zoom as source coverage improves.
  $: if (selectedMode === null && (daily.length || months.length)) {
    selectedMode = selectComparisonView(daily, months).mode;
  }
  $: view = selectComparisonView(daily, months, { mode: selectedMode });
  $: points = view.rows;
  function changeMode(mode) {
    if (mode === selectedMode) return;
    selectedMode = mode;
    zoomWindow = null;
  }
</script>

<div class="scope-toolbar" role="group" aria-label="Comparison date scope">
  <button aria-pressed={view.mode === 'verified'} on:click={() => changeMode('verified')}>[Latest verified]</button>
  <button aria-pressed={view.mode === 'full'} on:click={() => changeMode('full')}>[Full history]</button>
  <span>{view.fromDay ? `${view.fromDay} → ${view.throughDay} · UTC` : 'No shared verified coverage'}</span>
</div>
<p class="scope-note">{view.mode === 'verified'
  ? 'Latest continuous period with verified income and token subsidy for all three protocols. Every series uses the same dates.'
  : 'Full source history. Missing bars are unavailable, not zero; incomplete calendar buckets are not presented as full-period totals.'}</p>
<RangeSummary rows={points} window={zoomWindow} bucket={view.sourceGrain} metrics={PROTOCOLS.map(protocol => ({
  label: protocol.label + ' net income', kind: 'flow', unit: 'usd',
  value: row => view.sourceGrain === 'day' ? row[protocol.id]?.netUsd : row.protocols?.[protocol.id]?.complete ? row.protocols[protocol.id].netUsd : null
}))} note="After token subsidy. Only covered source buckets count. Totals and averages follow the selected range; calendar edges may be partial." />
<!-- Only an explicit scope change remounts the chart, resetting its grain and zoom. -->
{#key selectedMode}
  <TimeSeriesChart {points} options={{ hidden, nearNetSupply, thorchainRewardAccounting, sourceGrain: view.sourceGrain }} buildOption={buildComparisonTimeSeries}
    hideUnavailableGrains showSourceResolution={false} onHiddenChange={value => hidden = value}
    {zoomWindow} onZoom={value => zoomWindow = value} initialGrain={view.grain} hasData={points.length > 0} height="390px" narrowHeight="340px"
    emptyText="No common verified period is available. Full history shows each protocol’s available observations."
    ariaLabel="Swap income less network token subsidy for THORChain, NEAR Intents, and Chainflip. Signed USD. Daily, weekly, or monthly buckets when daily source data is available." />
{/key}

<style>
  .scope-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 14px; }
  button, span { font: 11px/1.5 var(--term-font-mono); }
  button { color: var(--term-text-3); background: transparent; border: 1px solid var(--term-border); border-radius: 0; min-height: 32px; padding: 5px 8px; cursor: pointer; }
  button[aria-pressed=true], button:hover { color: var(--term-accent); border-color: var(--term-accent); }
  button:focus-visible { outline: 1px solid var(--term-accent); outline-offset: 2px; }
  span { margin-left: auto; color: var(--term-text-3); }
  .scope-note { margin: 7px 0 10px; color: var(--term-text-3); font: 13px/1.55 var(--term-font-body); }
</style>
