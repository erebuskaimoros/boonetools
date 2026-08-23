<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import TerminalAlert from './components/terminal/TerminalAlert.svelte';
  import { subscribeChainHeads } from './api/chain-stream.js';
  import { fetchBurnTracker } from './burn-tracker/api.js';
  import {
    applyBurnTrackerHeadPayload,
    BURN_TRACKER_RANGES,
    formatBurnTrackerPrice,
    formatBurnTrackerRate,
    formatBurnTrackerRuneBase,
    normalizeBurnTrackerPayload,
    selectBurnTrackerRange
  } from './burn-tracker/model.js';
  import {
    renderBurnTrackerChart,
    setBurnTrackerPriceVisible
  } from './burn-tracker/charts.js';

  const REFRESH_MS = 5 * 60 * 1000;
  let payload = null;
  let loading = true;
  let refreshing = false;
  let loadError = '';
  let rangeId = '90d';
  let showPrice = false;
  let zoomWindow = null;
  let chartCanvas;
  let chart;
  let refreshTimer;
  let chainSubscription;
  let chainStreamConnected = false;
  let recentHeads = [];

  $: dashboard = normalizeBurnTrackerPayload(payload || {});
  $: rows = selectBurnTrackerRange(dashboard.daily, rangeId);
  $: windowStart = zoomWindow?.startDay || rows[0]?.day || '';
  $: windowEnd = zoomWindow?.endDay || rows.at(-1)?.day || '';
  $: currentDay = dashboard.daily.at(-1) || null;

  async function drawChart() {
    await tick();
    if (!chartCanvas || !rows.length) return;
    chart = renderBurnTrackerChart(chartCanvas, chart, rows, {
      showPrice,
      onZoom(range) { zoomWindow = range; }
    });
  }

  async function load(forceRefresh = false) {
    if (payload) refreshing = true;
    else loading = true;
    loadError = '';
    try {
      let nextPayload = await fetchBurnTracker({ forceRefresh });
      for (const head of recentHeads) nextPayload = applyBurnTrackerHeadPayload(nextPayload, head);
      payload = nextPayload;
      await drawChart();
    } catch (error) {
      loadError = error?.message || 'Burn Tracker data could not be loaded';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function handleChainHead(head) {
    chainStreamConnected = true;
    recentHeads = [...recentHeads.filter((candidate) => candidate.height !== head.height), head]
      .sort((left, right) => left.height - right.height)
      .slice(-256);
    if (!payload) return;
    const previousHeight = dashboard.liveHeight;
    const nextPayload = applyBurnTrackerHeadPayload(payload, head);
    if (nextPayload === payload || Number(head.height) <= previousHeight) return;
    payload = nextPayload;
    if (head.income_burn_e8 !== null && head.income_burn_e8 !== '0') await drawChart();
  }

  async function selectRange(range) {
    rangeId = range;
    zoomWindow = null;
    await drawChart();
  }

  function togglePrice() {
    showPrice = !showPrice;
    setBurnTrackerPriceVisible(chart, showPrice);
  }

  function resetZoom() {
    chart?.resetZoom?.();
    zoomWindow = null;
  }

  function displayDay(value) {
    if (!value) return '—';
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
      : value;
  }

  function displayTimestamp(value) {
    const parsed = new Date(value || '');
    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleString('en-US', { timeZone: 'UTC', hour12: false }) + ' UTC'
      : '—';
  }

  onMount(() => {
    load();
    chainSubscription = subscribeChainHeads({
      onOpen: () => { chainStreamConnected = true; },
      onError: () => { chainStreamConnected = false; },
      onUnavailable: () => { chainStreamConnected = false; },
      onHead: handleChainHead
    });
    refreshTimer = window.setInterval(() => load(true), REFRESH_MS);
  });

  onDestroy(() => {
    window.clearInterval(refreshTimer);
    chainSubscription?.close();
    chart?.destroy();
  });
</script>

<svelte:head>
  <title>RUNE Burn Tracker | BooneTools</title>
  <meta
    name="description"
    content="Track daily and cumulative RUNE burned through THORChain system income."
  />
</svelte:head>

<main class="burn-tracker">
  <header class="terminal-header">
    <div>
      <span class="eyebrow">THORCHAIN · SYSTEM ECONOMICS</span>
      <h1>RUNE BURN TRACKER</h1>
      <p>Observed RUNE permanently removed through <code>SYSTEMINCOMEBURNRATEBPS</code>.</p>
    </div>
    <div class="header-status" class:refreshing>
      <span class="status-dot"></span>
      <span>{refreshing ? 'RECONCILING' : chainStreamConnected ? `LIVE · BLOCK ${dashboard.liveHeight.toLocaleString('en-US')}` : dashboard.stale ? 'STALE MODEL' : '5M FALLBACK'}</span>
      <small>{displayTimestamp(dashboard.asOf)}</small>
    </div>
  </header>

  {#if loadError}
    <TerminalAlert tone="err" tag="ERR">
      {loadError} <button class="inline-action" on:click={() => load(true)}>retry</button>
    </TerminalAlert>
  {/if}
  {#if dashboard.stale}
    <TerminalAlert tone="warn" tag="STALE">Serving the last successful Burn Tracker snapshot.</TerminalAlert>
  {/if}
  {#each dashboard.warnings as warning}
    <TerminalAlert tone="warn" tag="DATA">{warning}</TerminalAlert>
  {/each}

  <section class="metric-grid" aria-label="Current RUNE burn metrics">
    <article class="metric-cell metric-cell--accent">
      <span class="metric-index">01</span>
      <span class="metric-label">SYSTEM INCOME BURNED</span>
      <strong>{formatBurnTrackerRuneBase(dashboard.totalBurnedBase)}</strong>
      <small>RUNE · ALL TIME</small>
    </article>
    <article class="metric-cell">
      <span class="metric-index">02</span>
      <span class="metric-label">CURRENT RUNE SUPPLY</span>
      <strong>{formatBurnTrackerRuneBase(dashboard.currentSupplyBase)}</strong>
      <small>BANK TOTAL · RUNE</small>
    </article>
    <article class="metric-cell metric-cell--rate">
      <span class="metric-index">03</span>
      <span class="metric-label">CURRENT BURN RATE</span>
      <strong>{formatBurnTrackerRate(dashboard.burnRatePercent)}</strong>
      <small>{dashboard.burnRateBps === null ? 'BPS UNAVAILABLE' : `${dashboard.burnRateBps} BASIS POINTS`}</small>
    </article>
  </section>

  <section class="chart-panel" aria-labelledby="burn-chart-title">
    <div class="panel-heading">
      <div>
        <span class="section-index">[01]</span>
        <h2 id="burn-chart-title">DAILY + CUMULATIVE BURN</h2>
        <p>UTC daily route burn with an all-time anchored cumulative series.</p>
      </div>
      {#if currentDay?.partial}
        <span class="live-badge"><i></i> LIVE PARTIAL · {currentDay.day}</span>
      {/if}
    </div>

    <div class="chart-controls" aria-label="Burn chart controls">
      <div class="window-copy">
        <span class="control-label">WINDOW</span>
        <span>{displayDay(windowStart)} → {displayDay(windowEnd)}</span>
        {#if zoomWindow}<b>CUSTOM ZOOM</b>{/if}
      </div>
      <div class="control-actions">
        <div class="range-group" aria-label="Date range">
          {#each BURN_TRACKER_RANGES as range}
            <button
              class:active={!zoomWindow && rangeId === range.id}
              aria-pressed={!zoomWindow && rangeId === range.id}
              on:click={() => selectRange(range.id)}
            >[{range.label}]</button>
          {/each}
        </div>
        <button
          class="price-toggle"
          class:active={showPrice}
          aria-pressed={showPrice}
          on:click={togglePrice}
        >[P] RUNE PRICE</button>
        <button class="reset" disabled={!zoomWindow} on:click={resetZoom}>[RESET ZOOM]</button>
      </div>
      <div class="zoom-hint">DRAG TO ZOOM · PINCH ON TOUCH · DOUBLE-CLICK TO RESET</div>
    </div>

    {#if loading && !rows.length}
      <div class="chart-loading" aria-live="polite">LOADING BURN HISTORY<span>_</span></div>
    {:else if rows.length}
      <div class="chart-wrap">
        <canvas
          bind:this={chartCanvas}
          aria-label="Daily RUNE burned as bars and cumulative RUNE burned as a line. Optional RUNE price can be enabled."
          on:dblclick={resetZoom}
        ></canvas>
      </div>
    {:else}
      <div class="chart-loading">NO BURN HISTORY AVAILABLE</div>
    {/if}

    <div class="chart-foot">
      <span>DAILY <b class="green">■</b></span>
      <span>CUMULATIVE <b class="amber">━</b></span>
      <span class:muted={!showPrice}>RUNE / USD <b class="blue">┄</b></span>
      <span class="source">SOURCE · LIQUIFY MIDGARD + PER-BLOCK REWARDS</span>
    </div>
  </section>

  <details class="data-table">
    <summary>ACCESSIBLE DAILY DATA · {rows.length} ROWS</summary>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>UTC DAY</th><th>DAILY RUNE</th><th>CUMULATIVE RUNE</th><th>RUNE / USD</th><th>STATE</th></tr>
        </thead>
        <tbody>
          {#each rows as row}
            <tr>
              <td>{row.day}</td>
              <td>{formatBurnTrackerRuneBase(row.burnedBase)}</td>
              <td>{formatBurnTrackerRuneBase(row.cumulativeBurnedBase)}</td>
              <td>{formatBurnTrackerPrice(row.runePriceUsd)}</td>
              <td class:partial={row.partial}>{row.partial ? 'LIVE PARTIAL' : row.burnedBase === null ? 'MISSING' : 'COMPLETE'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </details>

  <footer class="methodology">
    <span>METHOD</span>
    <p>
      Live values use the exact <code>income_burn</code> attribute from each on-chain
      <code>rewards</code> finalize-block event and reconcile against the Midgard earnings lane.
      Current supply is Cosmos bank total supply, not circulating or maximum supply.
    </p>
  </footer>
</main>

<style>
  .burn-tracker {
    width: min(1240px, calc(100% - 32px));
    margin: 0 auto;
    padding: 32px 0 72px;
    color: var(--term-text-1);
    font-family: var(--term-font-sans);
  }

  .terminal-header,
  .panel-heading,
  .chart-controls,
  .control-actions,
  .range-group,
  .chart-foot,
  .methodology {
    display: flex;
    align-items: center;
  }

  .terminal-header {
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 24px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--term-border);
  }

  .eyebrow,
  .metric-label,
  .metric-index,
  .section-index,
  .control-label,
  .header-status,
  .live-badge,
  .chart-controls,
  .chart-foot,
  summary,
  table,
  .methodology span {
    font-family: var(--term-font-mono);
  }

  .eyebrow {
    color: var(--term-accent);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.15em;
  }

  h1 {
    margin: 7px 0 5px;
    color: var(--term-text-1);
    font: 700 clamp(28px, 4vw, 46px)/1 var(--term-font-mono);
    letter-spacing: -0.05em;
  }

  .terminal-header p,
  .panel-heading p {
    margin: 0;
    color: var(--term-text-3);
    font-size: 13px;
  }

  code {
    color: var(--term-accent);
    font-family: var(--term-font-mono);
    font-size: 0.92em;
  }

  .header-status {
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 7px;
    min-width: 220px;
    color: var(--term-accent);
    font-size: 10px;
    letter-spacing: 0.1em;
  }

  .header-status small {
    flex-basis: 100%;
    color: var(--term-text-4);
    text-align: right;
  }

  .status-dot,
  .live-badge i {
    width: 6px;
    height: 6px;
    background: var(--term-accent);
  }

  .refreshing .status-dot { animation: pulse 1s steps(2, end) infinite; }

  :global(.burn-tracker > .alert) { margin-bottom: 10px; }
  .inline-action {
    margin-left: 8px;
    padding: 2px 5px;
    border: 1px solid currentColor;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    margin-bottom: 24px;
    border-top: 1px solid var(--term-border);
    border-left: 1px solid var(--term-border);
  }

  .metric-cell {
    position: relative;
    min-width: 0;
    padding: 20px;
    border-right: 1px solid var(--term-border);
    border-bottom: 1px solid var(--term-border);
    background: var(--term-surface);
  }

  .metric-index {
    position: absolute;
    top: 11px;
    right: 12px;
    color: var(--term-text-5);
    font-size: 9px;
  }

  .metric-label {
    display: block;
    margin-bottom: 12px;
    color: var(--term-text-3);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
  }

  .metric-cell strong {
    display: block;
    overflow: hidden;
    color: var(--term-text-1);
    font: 700 clamp(22px, 3vw, 34px)/1.1 var(--term-font-mono);
    letter-spacing: -0.04em;
    text-overflow: ellipsis;
  }

  .metric-cell--accent strong { color: var(--term-accent); }
  .metric-cell--rate strong { color: var(--term-amber); }
  .metric-cell small {
    display: block;
    margin-top: 8px;
    color: var(--term-text-4);
    font: 9px var(--term-font-mono);
    letter-spacing: 0.08em;
  }

  .chart-panel {
    border: 1px solid var(--term-border);
    background: var(--term-surface);
  }

  .panel-heading {
    justify-content: space-between;
    gap: 16px;
    padding: 16px 18px;
    border-bottom: 1px solid var(--term-border);
  }

  .section-index { color: var(--term-accent); font-size: 10px; }
  h2 {
    display: inline;
    margin: 0 0 0 8px;
    font: 700 14px var(--term-font-mono);
    letter-spacing: 0.06em;
  }
  .panel-heading p { margin-top: 5px; }

  .live-badge {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 8px;
    border: 1px solid rgba(0, 204, 102, 0.35);
    color: var(--term-accent);
    font-size: 9px;
    white-space: nowrap;
  }

  .chart-controls {
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 10px 16px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--term-border);
    background: var(--term-surface-deep);
    color: var(--term-text-3);
    font-size: 10px;
  }

  .window-copy { display: flex; flex-wrap: wrap; gap: 8px; }
  .window-copy b { color: var(--term-amber); }
  .control-label { color: var(--term-accent); font-weight: 700; letter-spacing: 0.1em; }
  .control-actions { flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
  .range-group { gap: 4px; }

  .chart-controls button {
    min-height: 36px;
    padding: 7px 9px;
    border: 1px solid var(--term-border);
    background: transparent;
    color: var(--term-text-3);
    cursor: pointer;
    font: 700 10px var(--term-font-mono);
  }
  .chart-controls button:hover:not(:disabled),
  .chart-controls button:focus-visible,
  .chart-controls button.active {
    border-color: var(--term-accent);
    color: var(--term-accent);
    outline: none;
  }
  .chart-controls .price-toggle.active { border-color: var(--term-info); color: var(--term-info); }
  .chart-controls button:disabled { opacity: 0.38; cursor: default; }
  .zoom-hint {
    flex-basis: 100%;
    padding-top: 8px;
    border-top: 1px solid var(--term-border-faint);
    color: var(--term-text-5);
    letter-spacing: 0.05em;
  }

  .chart-wrap {
    position: relative;
    height: 470px;
    padding: 12px 10px 5px;
  }
  .chart-wrap canvas { touch-action: pan-y; }
  .chart-loading {
    display: grid;
    height: 470px;
    place-items: center;
    color: var(--term-text-4);
    font: 11px var(--term-font-mono);
  }
  .chart-loading span { color: var(--term-accent); animation: pulse 1s steps(2, end) infinite; }

  .chart-foot {
    flex-wrap: wrap;
    gap: 14px;
    padding: 9px 14px;
    border-top: 1px solid var(--term-border);
    color: var(--term-text-4);
    font-size: 9px;
    letter-spacing: 0.06em;
  }
  .chart-foot .source { margin-left: auto; }
  .green { color: var(--term-accent); }
  .amber { color: var(--term-amber); }
  .blue { color: var(--term-info); }
  .muted { opacity: 0.4; }

  .data-table {
    margin-top: 14px;
    border: 1px solid var(--term-border);
    background: var(--term-surface);
  }
  summary {
    padding: 12px 14px;
    color: var(--term-text-3);
    font-size: 10px;
    cursor: pointer;
  }
  .table-scroll { max-height: 420px; overflow: auto; border-top: 1px solid var(--term-border); }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th, td { padding: 9px 12px; border-bottom: 1px solid var(--term-border-faint); text-align: right; }
  th { position: sticky; top: 0; background: var(--term-surface-deep); color: var(--term-text-4); }
  th:first-child, td:first-child { text-align: left; }
  td { color: var(--term-text-2); }
  td.partial { color: var(--term-accent); }

  .methodology {
    align-items: flex-start;
    gap: 14px;
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid var(--term-border);
    color: var(--term-text-4);
    font-size: 11px;
  }
  .methodology span { color: var(--term-amber); font-size: 9px; letter-spacing: 0.1em; }
  .methodology p { margin: 0; max-width: 900px; line-height: 1.6; }

  @keyframes pulse { 50% { opacity: 0.25; } }

  @media (prefers-reduced-motion: reduce) {
    .refreshing .status-dot,
    .chart-loading span { animation: none; }
  }

  @media (max-width: 800px) {
    .burn-tracker { width: min(100% - 20px, 1240px); padding-top: 20px; }
    .terminal-header, .panel-heading { align-items: flex-start; flex-direction: column; }
    .header-status { justify-content: flex-start; min-width: 0; }
    .header-status small { text-align: left; }
    .metric-grid { grid-template-columns: 1fr; }
    .control-actions, .range-group { align-items: stretch; width: 100%; }
    .range-group { display: grid; grid-template-columns: repeat(4, 1fr); }
    .control-actions { justify-content: flex-start; }
    .chart-controls button { flex: 1; }
    .chart-wrap, .chart-loading { height: 390px; }
    .chart-foot .source { width: 100%; margin-left: 0; }
  }
</style>
