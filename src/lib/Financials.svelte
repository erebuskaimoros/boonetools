<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import TerminalAlert from './components/terminal/TerminalAlert.svelte';
  import { FINANCIALS_SERIES, renderFinancialsChart } from './financials/charts.js';
  import { fetchFinancials } from './financials/api.js';
  import {
    FINANCIALS_RANGES, formatFinancialAmount, formatFinancialDay,
    formatFinancialPercent, summarizeFinancials
  } from '../../shared/financials/model.js';

  let range = '30d';
  let currency = 'usd';
  let payload = null;
  let loading = true;
  let refreshing = false;
  let error = '';
  let hidden = [];
  let zoomWindow = null;
  let canvas;
  let chart;
  let request;
  let timer;
  let sequence = 0;
  let destroyed = false;

  $: points = payload?.range === range ? payload.points : [];
  $: selectedPoints = zoomWindow ? points.filter((row) => row.day >= zoomWindow.startDay && row.day <= zoomWindow.endDay) : points;
  $: summary = summarizeFinancials(selectedPoints, currency);
  $: tablePoints = [...selectedPoints].reverse().slice(0, 30);
  $: hasData = points.some((point) => point.volumeRune !== null || point.incomeRune !== null);
  $: pending = payload?.range === range ? payload.bonding.pending : 0;
  $: livePoint = selectedPoints.find((point) => point.partial);
  $: sourceDelayed = payload?.stale || payload?.live?.stale;
  $: amount = (value, compact = true) => formatFinancialAmount(value, currency, compact);

  onMount(() => {
    load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });
  onDestroy(() => {
    destroyed = true;
    sequence++;
    clearTimeout(timer);
    request?.abort();
    chart?.destroy();
  });

  async function draw() {
    await tick();
    if (destroyed || !canvas) return;
    chart?.destroy();
    chart = hasData ? renderFinancialsChart(canvas, points, {
      currency, hidden, onZoom(window) { zoomWindow = window; }
    }) : null;
  }

  async function load(silent = false) {
    const id = ++sequence;
    request?.abort();
    request = new AbortController();
    clearTimeout(timer);
    if (!silent) loading = payload?.range !== range || !payload?.points?.length;
    refreshing = true;
    error = '';
    try {
      const data = await fetchFinancials(range, { signal: request.signal });
      if (id !== sequence || destroyed) return;
      const sameWindow = payload?.range === data.range && payload?.throughDay === data.throughDay;
      payload = data;
      loading = false;
      await tick();
      if (sameWindow && chart) chart.updatePoints(data.points);
      else { zoomWindow = null; await draw(); }
    } catch (failure) {
      if (failure.name !== 'AbortError' && id === sequence) error = failure.message || 'Protocol history could not be loaded';
    } finally {
      if (id === sequence && !destroyed) {
        loading = false;
        refreshing = false;
        timer = setTimeout(() => {
          if (document.visibilityState === 'visible') load(true);
          else scheduleVisibleRefresh();
        }, payload?.bonding?.pending || payload?.live?.bondPending ? 5000 : 30_000);
      }
    }
  }

  function scheduleVisibleRefresh() {
    if (destroyed) return;
    timer = setTimeout(() => {
      if (document.visibilityState === 'visible') load(true);
      else scheduleVisibleRefresh();
    }, 5000);
  }

  function selectRange(next) {
    if (next === range) return;
    range = next;
    zoomWindow = null;
    chart?.destroy();
    chart = null;
    load();
  }

  async function selectCurrency(next) {
    if (next === currency) return;
    currency = next;
    zoomWindow = null;
    await draw();
  }

  function toggleSeries(id) {
    if (!hidden.includes(id) && hidden.length === FINANCIALS_SERIES.length - 1) return;
    hidden = hidden.includes(id) ? hidden.filter((value) => value !== id) : [...hidden, id];
    chart?.setVisible(id, !hidden.includes(id));
  }
</script>

<svelte:head>
  <title>THORChain Financials | BooneTools</title>
  <meta name="description" content="THORChain protocol-wide daily swap volume, system income, and historical bonding APR." />
  {#if import.meta.env.DEV}<meta name="robots" content="noindex" />{/if}
</svelte:head>

<main class="financials">
  <div class="command-line">
    <span><span class="prompt">$</span> financials <span class="argument">--protocol thorchain</span></span>
    <div class="command-actions">
      {#if import.meta.env.DEV}<span class="dev-tag">DEV PREVIEW</span>{/if}
      <button class="bracket-button" on:click={() => load()} disabled={refreshing}><span>[R]</span> refresh</button>
    </div>
  </div>

  <header class="page-heading">
    <div>
      <h1>FINANCIALS<span class="cursor" aria-hidden="true">_</span></h1>
      <p>THORChain volume, system income, and the return to bonded RUNE.</p>
    </div>
    <div class="source-state" class:stale={sourceDelayed || Boolean(error)} aria-live="polite">
      <span><i class:live={!loading && !sourceDelayed && !error}></i>{loading ? 'LOADING HISTORY' : error ? 'SOURCE ERROR' : sourceDelayed ? 'SOURCE DELAYED' : 'LIVE · 5 MIN BUCKETS'}</span>
      <small>{payload?.live?.through ? `Updated through ${new Date(payload.live.through).toLocaleTimeString('en-US', { timeZone: 'UTC', hour12: false })} UTC` : 'Waiting for today’s first complete bucket'}</small>
    </div>
  </header>

  {#if error}
    <TerminalAlert tone="err" tag="ERR">{error} <button class="inline-action" on:click={() => load()}>retry</button></TerminalAlert>
  {/if}
  {#if payload?.stale}
    <TerminalAlert tone="warn" tag="DATA">The history source is delayed. Last indexed: {payload.asOf ? new Date(payload.asOf).toLocaleString('en-US', { timeZone: 'UTC', hour12: false }) : 'unknown'} UTC. {payload.error}</TerminalAlert>
  {/if}
  {#if payload?.live?.stale}
    <TerminalAlert tone="warn" tag="LIVE">Today’s feed is delayed; showing the last verified totals. {payload.live.error}</TerminalAlert>
  {/if}

  <section class="metric-grid" aria-label="Selected range summary" aria-busy={loading}>
    <div class="metric">
      <span class="metric-index">01 <span>{zoomWindow ? 'ZOOMED RANGE' : 'SELECTED RANGE'}</span></span>
      <h2>SWAP VOLUME</h2><strong class="volume-value">{amount(summary.volume.value)}</strong>
      <small>{summary.volume.days} / {summary.days} days observed{livePoint ? ' · today partial' : ''}</small>
    </div>
    <div class="metric">
      <span class="metric-index">02 <span>FEES + BLOCK REWARDS</span></span>
      <h2>SYSTEM INCOME</h2><strong class="income-value">{amount(summary.income.value)}</strong>
      <small>{summary.income.days} / {summary.days} days observed{livePoint ? ' · today partial' : ''}</small>
    </div>
    <div class="metric">
      <span class="metric-index">03 <span>DAILY AVERAGE</span></span>
      <h2>INCOME / DAY</h2><strong>{amount(summary.averageDailyIncome)}</strong>
      <small>Across {summary.averageIncomeDays} completed days</small>
    </div>
    <div class="metric">
      <span class="metric-index">04 <span>DAILY ANNUALIZED RATE</span></span>
      <h2>AVG BONDING APR</h2><strong class="apr-value">{formatFinancialPercent(summary.averageApr)}</strong>
      <small>{summary.averageAprDays} / {summary.completedDays} completed days</small>
    </div>
  </section>

  <section class="chart-panel" aria-labelledby="financial-chart-title">
    <div class="panel-heading">
      <h2 id="financial-chart-title"><span aria-hidden="true">▌</span> PROTOCOL FINANCIALS</h2>
      <div class="chart-controls">
        <div class="button-group" aria-label="Chart range">
          {#each FINANCIALS_RANGES as item}
            <button class:active={range === item.id} aria-pressed={range === item.id} on:click={() => selectRange(item.id)}>{item.label}</button>
          {/each}
        </div>
        <div class="button-group currency-toggle" aria-label="Chart currency">
          <button class:active={currency === 'usd'} aria-pressed={currency === 'usd'} on:click={() => selectCurrency('usd')}>USD</button>
          <button class:active={currency === 'rune'} aria-pressed={currency === 'rune'} on:click={() => selectCurrency('rune')}>RUNE</button>
        </div>
      </div>
    </div>
    <div class="chart-toolbar">
      <div class="legend" aria-label="Chart series">
        {#each FINANCIALS_SERIES as series}
          <button class:muted={hidden.includes(series.id)} aria-pressed={!hidden.includes(series.id)} on:click={() => toggleSeries(series.id)}>
            <span class:line-swatch={series.id === 'bondingApr'} style={`--series-color: ${series.color}`}></span>{series.label}
          </button>
        {/each}
      </div>
      {#if zoomWindow}<button class="bracket-button" on:click={() => chart?.resetZoom()}><span>[↺]</span> reset zoom</button>{/if}
    </div>

    <div class="chart-frame" aria-busy={loading}>
      <canvas bind:this={canvas} aria-label="Daily THORChain swap volume and system income bars with a bonding APR line. Each series has its own labeled axis. Daily values are available in the table below."></canvas>
      {#if loading}
        <div class="chart-message" role="status"><span class="loader" aria-hidden="true">▓░░░░</span> Loading {range === 'all' ? 'mainnet' : 'daily'} history…</div>
      {:else if !hasData}
        <div class="chart-message">{error ? 'History could not be loaded. Use retry above.' : 'No protocol history is available for this range.'}</div>
      {/if}
    </div>
    <div class="chart-footer">
      <span>{formatFinancialDay(selectedPoints[0]?.day)} → {formatFinancialDay(selectedPoints.at(-1)?.day)} <span class="muted-text">· UTC</span></span>
      <span>Independent scales <span class="muted-text">·</span> Drag or pinch to zoom</span>
    </div>
    {#if livePoint}
      <div class="live-note"><span>TODAY · IN PROGRESS</span>
        {#if payload?.live?.through}
          Through {new Date(payload.live.through).toLocaleTimeString('en-US', { timeZone: 'UTC', hour12: false })} UTC · APR run rate {formatFinancialPercent(livePoint.bondingApr)}
        {:else}Waiting for the first completed five-minute bucket.{/if}
        <small>Checks every 30 seconds. Today is included in totals; daily averages use completed days only.</small>
      </div>
    {/if}
    {#if pending}
      <div class="coverage-note" role="status">Loading historical bonds · {summary.aprDays} / {summary.days} APR days ready. The line fills in as snapshots arrive.</div>
    {:else if hasData && summary.aprDays < summary.days}
      <div class="coverage-note">Bonding APR is available for {summary.aprDays} / {summary.days} days. Gaps indicate unavailable historical validator state.</div>
    {/if}
    {#if hasData && (summary.income.days < summary.days || summary.volume.days < summary.days)}
      <div class="coverage-note">Some daily values are missing. Totals and averages include only observed days.</div>
    {/if}
  </section>

  <section class="methodology" aria-label="Metric definitions">
    <div><h2><span class="volume-value">01</span> VOLUME</h2><p>Executed swap volume across every pool, including trade, secured, and synth swaps. Cross-asset swaps contribute both pool legs.</p></div>
    <div><h2><span class="income-value">02</span> SYSTEM INCOME</h2><p>Liquidity fees plus Reserve block rewards, before distribution. USD income uses each day’s closing RUNE price, or the latest covered five-minute price for today. Swap USD uses prices at execution.</p></div>
    <div><h2><span class="apr-value">03</span> BONDING APR</h2><p>Daily node rewards ÷ closing active bond × 365. Today’s estimate scales rewards by the elapsed covered time, using a bond snapshot at the same cutoff. Snapshots reflect bonds, unbonds, and active-set changes; balances are not time-weighted. Excludes individual fees and performance adjustments.</p></div>
  </section>

  {#if hasData}
    <details class="daily-data">
      <summary>DAILY DATA <span>[{tablePoints.length} most recent days in view]</span></summary>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll the data table.) -->
      <div class="table-scroll" tabindex="0" role="region" aria-label="Daily financials table">
        <table>
          <thead><tr><th scope="col">DAY · UTC</th><th scope="col">VOLUME · {currency.toUpperCase()}</th><th scope="col">SYSTEM INCOME · {currency.toUpperCase()}</th><th scope="col">BONDING APR</th></tr></thead>
          <tbody>{#each tablePoints as row}<tr class:partial={row.partial}><th scope="row">{row.day}{#if row.partial}<span class="partial-label">LIVE / PARTIAL</span>{/if}</th><td>{amount(currency === 'usd' ? row.volumeUsd : row.volumeRune, false)}</td><td>{amount(currency === 'usd' ? row.incomeUsd : row.incomeRune, false)}</td><td class="apr-value">{formatFinancialPercent(row.bondingApr)}{row.partial ? ' est.' : ''}</td></tr>{/each}</tbody>
        </table>
      </div>
    </details>
  {/if}

  <footer class="data-source">SOURCES <a href="https://gateway.liquify.com/chain/thorchain_midgard/v2/doc" target="_blank" rel="noreferrer">Midgard</a> + historical THORNode state via Liquify <span>·</span> Mainnet history from 13 Apr 2021</footer>
</main>

<style>
  .financials { max-width: 1440px; margin: 0 auto; padding: 24px 24px 56px; color: var(--term-text-body); font-family: var(--term-font-mono); }
  .financials :global(*) { font-family: inherit; }
  .command-line, .command-actions, .chart-controls, .panel-heading, .chart-toolbar, .legend, .chart-footer { display: flex; align-items: center; gap: 12px; }
  .command-line { justify-content: space-between; border-bottom: 1px solid var(--term-border); padding-bottom: 14px; font-family: var(--term-font-mono); font-size: 12px; }
  .prompt, .cursor, .panel-heading h2 > span, .metric-index, .bracket-button > span { color: var(--term-accent); }
  .argument, .muted-text { color: var(--term-text-4); }
  .dev-tag { padding: 3px 7px; border: 1px solid var(--term-border); color: var(--term-amber); font-size: 11px; }
  button, summary, .source-state, h1, h2, .metric, .chart-footer, .coverage-note, .data-source, table { font-family: var(--term-font-mono); }
  button { cursor: pointer; border-radius: 0; background: transparent; color: var(--term-text-2); transition: border-color .15s ease, color .15s ease; }
  button:focus-visible, summary:focus-visible, .table-scroll:focus-visible { outline: 2px solid var(--term-accent); outline-offset: 3px; }
  button:disabled { cursor: wait; opacity: .65; }
  .bracket-button { border: 1px solid var(--term-border); font-size: 11px; padding: 6px 10px; }
  .bracket-button:hover, .button-group button:hover { border-color: var(--term-accent); color: var(--term-accent); }
  .page-heading { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin: 28px 0 24px; }
  h1 { margin: 0; color: var(--term-text); font-size: 30px; font-weight: 800; letter-spacing: .06em; line-height: 1.1; }
  .cursor { animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .page-heading p { margin: 10px 0 0; color: var(--term-text-3); font-size: 14px; font-family: var(--term-font-body); }
  .source-state { display: grid; gap: 8px; text-align: right; font-size: 11px; white-space: nowrap; }
  .source-state > span { color: var(--term-accent); }
  .source-state.stale > span { color: var(--term-amber); }
  .source-state i { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin-right: 8px; }
  .source-state i.live { animation: live-pulse 2s infinite; }
  @keyframes live-pulse { 50% { opacity: .45; } }
  .source-state small { font-size: 11px; color: var(--term-text-3); }
  .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--term-border); background: var(--term-surface); margin-bottom: 24px; }
  .metric { min-width: 0; padding: 16px 18px; border-right: 1px solid var(--term-border); }
  .metric:last-child { border-right: 0; }
  .metric-index { display: flex; gap: 10px; align-items: center; font-size: 10px; font-weight: 700; }
  .metric-index > span { color: var(--term-text-4); letter-spacing: .04em; }
  .metric h2 { font-size: 11px; letter-spacing: .08em; margin: 16px 0 10px; font-weight: 600; }
  .metric strong { display: block; color: var(--term-text); font-size: 26px; font-weight: 800; }
  .metric small { display: block; margin-top: 10px; color: var(--term-text-4); font-size: 11px; }
  .volume-value { color: var(--term-info) !important; }
  .income-value { color: var(--term-amber) !important; }
  .apr-value { color: var(--term-accent) !important; }
  .chart-panel { border: 1px solid var(--term-border); background: var(--term-surface); padding: 20px; }
  .panel-heading { justify-content: space-between; flex-wrap: wrap; }
  .panel-heading h2 { margin: 0; font-size: 13px; letter-spacing: .08em; }
  .button-group { display: flex; }
  .button-group button { padding: 7px 11px; border: 1px solid var(--term-border); font-size: 11px; font-weight: 600; margin-left: -1px; }
  .button-group button.active { border-color: var(--term-accent); color: var(--term-accent); background: var(--term-accent-soft); z-index: 1; }
  .chart-toolbar { justify-content: space-between; min-height: 52px; margin: 6px 0; }
  .legend { flex-wrap: wrap; gap: 8px 20px; }
  .legend button { display: flex; align-items: center; gap: 8px; padding: 6px 0; border: 0; font-size: 11px; }
  .legend button.muted { color: var(--term-text-4); text-decoration: line-through; }
  .legend button > span { width: 11px; height: 11px; background: var(--series-color); }
  .legend button > span.line-swatch { height: 2px; width: 18px; }
  .legend button.muted > span { background: var(--term-text-4); }
  .chart-frame { position: relative; height: 430px; width: 100%; }
  .chart-frame canvas { width: 100%; height: 100%; }
  .chart-message { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 12px; background: var(--term-surface); font-family: var(--term-font-mono); font-size: 12px; color: var(--term-text-3); }
  .loader { color: var(--term-accent); animation: blink 1s steps(1) infinite; }
  .chart-footer { justify-content: space-between; flex-wrap: wrap; border-top: 1px solid var(--term-border); padding-top: 14px; margin-top: 16px; font-size: 11px; color: var(--term-text-3); }
  .coverage-note { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--term-border); color: var(--term-text-3); font-size: 11px; line-height: 1.6; }
  .live-note { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--term-border); font-size: 11px; line-height: 1.8; color: var(--term-text-2); }
  .live-note > span { color: var(--term-accent); margin-right: 12px; }
  .live-note small { display: block; font-size: 11px; color: var(--term-text-3); }
  .partial-label { display: block; font-size: 11px; color: var(--term-accent); margin-top: 5px; }
  tr.partial { background: var(--term-accent-soft); }
  .methodology { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; padding: 24px 0; }
  .methodology h2 { font-size: 11px; letter-spacing: .08em; margin: 0 0 10px; }
  .methodology h2 span { margin-right: 6px; }
  .methodology p { font-size: 13px; line-height: 1.65; color: var(--term-text-3); margin: 0; font-family: var(--term-font-body); }
  .daily-data { border-top: 1px solid var(--term-border); border-bottom: 1px solid var(--term-border); }
  .daily-data summary { cursor: pointer; padding: 16px 0; font-size: 11px; font-weight: 600; letter-spacing: .04em; }
  .daily-data summary span { margin-left: 12px; color: var(--term-text-4); font-weight: 400; }
  .table-scroll { overflow: auto; max-height: 430px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; white-space: nowrap; }
  td, th { text-align: right; padding: 12px; border-bottom: 1px solid var(--term-border); font-weight: 400; }
  td:first-child, th:first-child { text-align: left; }
  thead th { color: var(--term-text-3); font-size: 11px; background: var(--term-surface); position: sticky; top: 0; }
  tbody tr:hover { background: var(--term-surface-hover); }
  .data-source { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--term-text-4); margin-top: 24px; line-height: 1.6; }
  .data-source a { color: var(--term-text-2); text-decoration: underline; text-underline-offset: 3px; }
  .inline-action { border: 0; text-decoration: underline; font-size: 12px; }
  @media (max-width: 1050px) {
    .metric { padding: 14px; }
    .metric-index > span { font-size: 10px; }
    .metric strong { font-size: 23px; }
  }
  @media (max-width: 700px) {
    .financials { padding: 12px 16px 56px; }
    .argument { display: none; }
    .page-heading { align-items: flex-start; flex-direction: column; margin: 24px 0; }
    .source-state { text-align: left; }
    .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .metric:nth-child(2) { border-right: 0; }
    .metric:nth-child(-n+2) { border-bottom: 1px solid var(--term-border); }
    .metric-index > span { font-size: 10px; letter-spacing: 0; }
    .metric-index { gap: 6px; }
    .metric strong { font-size: 24px; }
    .chart-panel { padding: 16px 10px; }
    .chart-controls { gap: 12px; flex-wrap: wrap; }
    .button-group button { padding: 7px 10px; }
    .chart-toolbar { align-items: flex-start; flex-direction: column; gap: 2px; margin: 14px 0; }
    .legend { gap: 3px 14px; }
    .chart-frame { height: 360px; }
    .chart-footer { gap: 10px; line-height: 1.6; }
    .methodology { grid-template-columns: 1fr; gap: 20px; }
    .daily-data summary span { display: block; margin: 8px 0 0 15px; }
  }
  @media (prefers-reduced-motion: reduce) { .cursor, .loader, .source-state i.live { animation: none; } }
</style>
