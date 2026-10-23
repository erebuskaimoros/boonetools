<script>
  import RangeSummary from '../charts/RangeSummary.svelte';
  import TimeSeriesChart from '../charts/TimeSeriesChart.svelte';
  import { buildFeeShareOption, feeShareSummary, normalizeFeeComposition, selectFeeCompositionRange } from './composition.js';

  export let rows = [];
  export let loading = false;
  export let error = '';
  let range = 90;
  let zoomWindow = null;
  $: history = normalizeFeeComposition(rows);
  $: points = selectFeeCompositionRange(history, range);
  $: resetWindow = points.length ? { startDay: points[0].day, endDay: points.at(-1).day } : null;
  $: selected = zoomWindow ? points.filter(row => row.day >= zoomWindow.startDay && row.day <= zoomWindow.endDay) : points;
  $: summary = feeShareSummary(selected);
  $: hasData = points.some(row => row.complete && row.totalFeesUsd > 0);
  function selectRange(value) { range = value; zoomWindow = null; }
</script>

<section class="fee-share" aria-labelledby="pool-fee-share-title">
  <div class="block-head">
    <h2 id="pool-fee-share-title"><span aria-hidden="true">▌</span> FEES BY POOL CATEGORY</h2>
    <span class="meta">[4 BUCKETS · 100%]</span>
  </div>
  <p class="note">Share of liquidity fees from BTC.BTC, ETH.ETH, stablecoin pools across all chains, and other pools. Excludes block rewards and downstream income allocations.</p>
  <RangeSummary rows={selected} cards={summary.cards} {loading}
    note={`${summary.verifiedDays} verified days · ${summary.missingDays} unavailable${selected.some(row => row.partial) ? ' · current day is partial' : ''}. Shares are weighted by historical USD fees; missing attribution is not counted as “other”.`} />
  <TimeSeriesChart {points} historyPoints={history} buildOption={buildFeeShareOption}
    {zoomWindow} {resetWindow} onZoom={value => zoomWindow = value} {loading} {error} {hasData}
    ariaLabel="Percentage of THORChain liquidity fees from BTC, ETH, stablecoin pools and other pools over time"
    emptyText="No reconciled pool fee breakdown is available for this window."
    loadingText="Loading cached pool fee shares…">
    <div class="range-controls" slot="controls" role="group" aria-label="Pool fee share time range">
      <span>{points[0]?.day || '—'} → {points.at(-1)?.day || '—'} UTC</span>
      {#each [{ value: 30, label: '30D' }, { value: 90, label: '90D' }, { value: 365, label: '1Y' }, { value: 'all', label: 'ALL' }] as preset}
        <button aria-pressed={range === preset.value} on:click={() => selectRange(preset.value)}>[{preset.label}]</button>
      {/each}
    </div>
  </TimeSeriesChart>
  <p class="note foot">Daily, weekly and monthly shares use summed fees, not averages of daily percentages. Gaps indicate incomplete attribution or days without fees. Hiding a category does not change the denominator.</p>
</section>

<style>
  .fee-share { margin-top: 24px; padding: 18px 20px; border: 1px solid var(--term-border); background: var(--term-surface); min-width: 0; }
  .block-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
  h2 { margin: 0; font: 700 14px/1.2 var(--term-font-mono); letter-spacing: .08em; color: var(--term-text); }
  h2 span { color: var(--term-accent); }
  .meta, .range-controls { font: 11px var(--term-font-mono); color: var(--term-text-3); }
  .note { margin: 0; font: 13px/1.6 'DM Sans', sans-serif; color: var(--term-text-3); }
  .foot { margin-top: 12px; }
  .range-controls { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
  .range-controls span { margin-right: auto; }
  button { min-height: 32px; padding: 5px 8px; border: 1px solid var(--term-border); border-radius: 0; background: transparent; color: var(--term-text-3); font: 11px var(--term-font-mono); cursor: pointer; }
  button[aria-pressed=true], button:hover { color: var(--term-accent); border-color: var(--term-accent); }
  button:focus-visible { outline: 1px solid var(--term-accent); outline-offset: 2px; }
  @media (max-width: 600px) { .fee-share { padding: 14px 10px; } }
</style>
