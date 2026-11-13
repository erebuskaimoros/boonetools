<script context="module">
  // Survives tab switches so returning to the tab redraws immediately while a
  // fresh read runs in the background.
  let cachedPayload = null;
  let savedView = null;
</script>

<script>
  import { onDestroy, onMount } from 'svelte';
  import RangeSummary from '../charts/RangeSummary.svelte';
  import TimeSeriesChart from '../charts/TimeSeriesChart.svelte';
  import { createVisiblePoll } from '../utils/visible-poll.js';
  import {
    DEFAULT_STABLE_SWAP_RANGE,
    STABLE_SWAP_RANGES,
    fetchStableSwaps,
    normalizeStableSwapsPayload,
    selectStableSwapRange,
    stableSwapBackfillNote
  } from './stable-swaps.js';
  import { STABLE_SWAP_DEFAULT_HIDDEN, buildStableSwapsOption } from './stable-swaps-chart.js';

  const REFRESH_MS = 5 * 60_000;

  let payload = cachedPayload;
  let loading = !cachedPayload;
  let refreshing = false;
  let loadError = '';
  let rangeId = savedView?.rangeId || DEFAULT_STABLE_SWAP_RANGE;
  let zoomWindow = null;
  let hidden = savedView?.hidden || [...STABLE_SWAP_DEFAULT_HIDDEN];
  let controller = null;
  let poll = null;
  let destroyed = false;

  $: dashboard = normalizeStableSwapsPayload(payload);
  $: backfillNote = stableSwapBackfillNote(dashboard);
  $: hasHistory = Boolean(dashboard.coverageStart) && dashboard.days.length > 0;
  $: rows = hasHistory ? selectStableSwapRange(dashboard.days, rangeId) : [];
  $: historyRows = hasHistory ? dashboard.days : [];
  $: rangeLabel = STABLE_SWAP_RANGES.find((range) => range.id === rangeId)?.label || 'ALL';
  $: windowStart = zoomWindow?.startDay || rows[0]?.day || '';
  $: windowEnd = zoomWindow?.endDay || rows.at(-1)?.day || '';
  $: emptyText = payload && !hasHistory
    ? 'NO STABLE ↔ STABLE HISTORY YET · HISTORY BEGINS WHEN THE SWAP LEDGER DOES'
    : 'NO STABLE ↔ STABLE SWAPS IN THIS RANGE';

  async function load(forceRefresh = false) {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    if (payload) refreshing = true;
    else loading = true;
    try {
      const next = await fetchStableSwaps({ forceRefresh, signal: current.signal });
      if (destroyed || current.signal.aborted) return;
      payload = next;
      cachedPayload = next;
      loadError = '';
    } catch (failure) {
      if (destroyed || current.signal.aborted || failure?.name === 'AbortError') return;
      loadError = failure?.message || 'Stable swap history could not be loaded';
    } finally {
      if (controller === current) {
        loading = false;
        refreshing = false;
        controller = null;
      }
    }
  }

  // Legend visibility and range survive switching dashboard tabs.
  function saveView() {
    savedView = { rangeId, hidden };
  }

  function selectRange(id) {
    rangeId = id;
    zoomWindow = null;
    saveView();
  }

  function changeHidden(ids) {
    hidden = ids;
    saveView();
  }

  onMount(() => {
    poll = createVisiblePoll(() => load(Boolean(payload)), { intervalMs: REFRESH_MS });
  });

  onDestroy(() => {
    destroyed = true;
    poll?.stop();
    controller?.abort();
  });
</script>

<section class="block stable-swaps-block" aria-labelledby="stable-swaps-title">
  <div class="block-head">
    <div class="block-title"><span class="title-marker">▌</span><h2 id="stable-swaps-title">Stable ↔ Stable Swaps</h2></div>
    <div class="block-meta">[{rangeLabel} / {zoomWindow ? 'zoom' : 'utc days'}{refreshing ? ' / refreshing' : ''}]</div>
  </div>

  <p class="lede">
    Swaps where both the input and output asset are USD stablecoins{dashboard.stableSymbols.length ? ` (${dashboard.stableSymbols.join(', ')})` : ''}.
    Volume is the input amount; fees are charged in RUNE and shown in USD where priced.
  </p>

  {#if loadError && payload}
    <div class="alert warn" role="status"><span>WRN</span>{loadError} · showing last loaded history</div>
  {/if}

  <div class="chart-controls">
    <span class="window-label">{windowStart || '—'} → {windowEnd || '—'} UTC{zoomWindow ? ' · CUSTOM ZOOM' : ''}</span>
    <div class="control-actions">
      <span class="chart-control-label">range</span>
      <div class="timeframe-tabs" role="group" aria-label="Stable swap chart timeframe">
        {#each STABLE_SWAP_RANGES as range}
          <button
            type="button"
            class:active={!zoomWindow && rangeId === range.id}
            aria-pressed={!zoomWindow && rangeId === range.id}
            on:click={() => selectRange(range.id)}
          >{range.label}</button>
        {/each}
      </div>
      <button type="button" class="reset" disabled={!zoomWindow} on:click={() => zoomWindow = null}>[reset zoom]</button>
    </div>
  </div>
  <div class="zoom-hint">drag to highlight + zoom · double-click resets</div>

  <RangeSummary {rows} window={zoomWindow} {loading} metrics={[
    { field: 'volumeUsd', label: 'Volume', kind: 'flow', unit: 'usd' },
    { field: 'feesUsd', label: 'Fees', kind: 'flow', unit: 'usd' }
  ]} note="Raw daily volume and fees; rolling-average overlays are not summed. The live UTC day is partial." />

  <TimeSeriesChart
    points={rows}
    historyPoints={historyRows}
    options={{ hidden }}
    onHiddenChange={changeHidden}
    buildOption={buildStableSwapsOption}
    {zoomWindow}
    onZoom={(window) => zoomWindow = window}
    {loading}
    hasData={rows.length > 0}
    error={!payload && loadError ? `ERR · ${loadError}` : ''}
    height="400px"
    narrowHeight="340px"
    loadingText="LOADING STABLE SWAP HISTORY"
    {emptyText}
    ariaLabel="Stablecoin-to-stablecoin swap volume and fees in US dollars as paired daily bars on separate axes, and an optional dashed effective fee rate in basis points. Drag to zoom; the range summary above lists totals for the visible window."
  />

  <div class="chart-foot">
    <span>SOURCE · {dashboard.source.toUpperCase()}</span>
    {#if dashboard.coverageStart}<span>COVERAGE FROM {dashboard.coverageStart} UTC</span>{/if}
    <span>INPUT STABLECOIN VALUED AT $1</span>
    {#if backfillNote}<span>{backfillNote}</span>{/if}
  </div>
</section>

<style>
  .block {
    border: 1px solid var(--term-border, #1a1a1a);
    background: var(--term-surface, #0a0a0a);
    padding: 18px 20px 22px;
    margin-bottom: 14px;
    min-width: 0;
  }

  .block-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid #141414;
    margin-bottom: 12px;
  }

  .block-title {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .title-marker {
    color: var(--term-accent, #00cc66);
  }

  h2 {
    margin: 0;
    font-family: var(--term-font-mono);
    font-size: 14px;
    font-weight: 700;
    color: #d8d8d8;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .block-meta,
  .chart-control-label,
  .window-label,
  .zoom-hint,
  .reset,
  .chart-foot,
  .alert,
  .timeframe-tabs button {
    font-family: var(--term-font-mono);
    font-size: var(--term-type-label);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .block-meta {
    color: var(--term-text-4);
    flex-shrink: 0;
  }

  .lede {
    margin: 0 0 12px;
    color: var(--term-text-2);
    font-family: var(--term-font-body);
    font-size: 13px;
    line-height: 1.55;
  }

  .alert {
    display: flex;
    gap: 10px;
    margin: 0 0 10px;
    padding: 8px 10px;
    border: 1px solid #1a1a1a;
    border-left: 2px solid var(--term-amber, #d4a017);
    color: var(--term-text-2);
  }

  .alert span {
    color: var(--term-amber, #d4a017);
    font-weight: 700;
  }

  .chart-controls,
  .control-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .chart-controls {
    justify-content: space-between;
    gap: 10px 16px;
  }

  .window-label,
  .chart-control-label,
  .zoom-hint {
    color: var(--term-text-3);
  }

  .zoom-hint {
    margin: 6px 0 0;
    text-align: right;
  }

  .timeframe-tabs {
    display: inline-flex;
    border: 1px solid #1a1a1a;
    background: #050505;
  }

  .timeframe-tabs button {
    min-height: 30px;
    background: transparent;
    border: none;
    border-right: 1px solid #1a1a1a;
    color: var(--term-text-2);
    cursor: pointer;
    letter-spacing: 0.1em;
    padding: 7px 10px;
  }

  .timeframe-tabs button:last-child {
    border-right: none;
  }

  .timeframe-tabs button:hover,
  .timeframe-tabs button.active {
    color: #00cc66;
    background: #0b0b0b;
  }

  .reset {
    min-height: 30px;
    background: transparent;
    border: 1px solid #1a1a1a;
    color: var(--term-text-3);
    cursor: pointer;
    padding: 4px 8px;
  }

  .reset:hover:not(:disabled),
  .reset:focus-visible {
    border-color: #00cc66;
    color: #00cc66;
    outline: none;
  }

  .reset:disabled {
    color: var(--term-text-6);
    cursor: default;
    opacity: 0.7;
  }

  .chart-foot {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px dashed #1a1a1a;
    color: var(--term-text-3);
  }

  @media (max-width: 600px) {
    .block {
      padding: 14px 12px 16px;
    }

    .block-head {
      flex-direction: column;
      gap: 6px;
    }

    .zoom-hint {
      text-align: left;
    }
  }
</style>
