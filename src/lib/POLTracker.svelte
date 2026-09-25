<script>
  import { onDestroy, onMount } from 'svelte';
  import TimeSeriesChart from './charts/TimeSeriesChart.svelte';
  import { buildPolTrackerOption } from './pol-tracker/charts.js';
  import TerminalAlert from './components/terminal/TerminalAlert.svelte';
  import { fetchPolTracker } from './pol-tracker/api.js';
  import {
    POL_TRACKER_GROUPS,
    POL_TRACKER_RANGES,
    POL_TRACKER_SERIES,
    formatPolTrackerRune,
    formatPolTrackerUsd,
    normalizePolTrackerPayload,
    relevantPolTrackerPools,
    selectPolTrackerRange,
    totalPolTrackerValue
  } from './pol-tracker/model.js';

  const REFRESH_MS = 5 * 60 * 1000;
  let payload = null;
  let loading = true;
  let refreshing = false;
  let loadError = '';
  let rangeId = 'all';
  let chartHost;
  let hiddenSeries = [];
  let hoveredDay = null;
  let inspectedDay = '';
  let zoomWindow = null;
  let refreshTimer;

  $: dashboard = normalizePolTrackerPayload(payload || {});
  $: rangeRows = selectPolTrackerRange(dashboard.daily, rangeId);
  $: rows = zoomWindow
    ? rangeRows.filter(row => row.day >= zoomWindow.startDay && row.day <= zoomWindow.endDay)
    : rangeRows;
  $: isZoomed = Boolean(zoomWindow);
  $: chartGroup = POL_TRACKER_GROUPS[0];
  $: selected = rows.find(row => row.day === hoveredDay)
    || rows.find(row => row.day === inspectedDay) || rows.at(-1) || null;
  $: displayedTotal = totalPolTrackerValue(selected);
  $: relevantPools = relevantPolTrackerPools(dashboard.latestPools);
  $: latest = dashboard.latest;
  $: currentSystemIncomePol = dashboard.currentSystemIncomePol;
  $: systemIncomePolUsd = currentSystemIncomePol?.positionUsd ?? latest?.systemIncomePolUsd;
  $: systemIncomePolRune = currentSystemIncomePol?.positionRune ?? latest?.systemIncomePolRune;
  $: latestTotal = totalPolTrackerValue(latest);
  $: coveragePercent = dashboard.coverage.expected_days
    ? (dashboard.coverage.observed_days / dashboard.coverage.expected_days) * 100
    : 0;

  onMount(() => {
    load({ forceRefresh: true });
    refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load({ forceRefresh: true, silent: true });
    }, REFRESH_MS);
  });

  onDestroy(() => clearInterval(refreshTimer));

  async function load(options = {}) {
    if (refreshing) return;
    refreshing = true;
    if (!options.silent) loading = !payload;
    loadError = '';
    try {
      payload = await fetchPolTracker({ forceRefresh: options.forceRefresh });
    } catch (error) {
      loadError = error?.message || 'POL TVL history is unavailable.';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function setRange(nextRange) {
    rangeId = nextRange;
    zoomChanged(null);
  }
  function zoomChanged(window) {
    zoomWindow = window;
    hoveredDay = null;
    inspectedDay = '';
  }
  function resetZoom() { chartHost?.resetZoom(); }

  function axisDate(value) {
    if (!value) return '';
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${value}T00:00:00Z`));
  }

  function fullDate(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC'
    }).format(new Date(`${value}T00:00:00Z`));
  }

</script>

<svelte:head>
  <title>POL TVL | BooneTools</title>
  <meta name="description" content="Daily THORChain synth backing, Treasury LP, legacy Reserve POL, and System Income POL history." />
</svelte:head>

<main class="pol-shell">
  <header class="terminal-header">
    <div>
      <p class="eyebrow">$ boonetools pol-tvl --from 2025-02-01</p>
      <h1>POL TVL</h1>
      <p class="subtitle">Daily protocol liquidity and liability state at completed UTC day-end blocks.</p>
    </div>
    <div class="header-state">
      <span class:stale={dashboard.stale} class="state-dot"></span>
      <span>{loading ? 'SYNCING' : dashboard.stale ? 'STALE' : loadError ? 'ERROR' : 'READY'}</span>
      <button class="refresh" on:click={() => load({ forceRefresh: true })} disabled={refreshing}>
        [{refreshing ? '…' : 'R'}] REFRESH
      </button>
    </div>
  </header>

  {#if loadError}
    <TerminalAlert tone="err" tag="ERR">{loadError}</TerminalAlert>
  {:else if loading}
    <TerminalAlert tone="info" tag="SYNC">Loading the durable daily read model…</TerminalAlert>
  {/if}

  {#if dashboard.stale}
    <TerminalAlert tone="warn" tag="STALE">The latest successful daily model is older than its 36-hour freshness window.</TerminalAlert>
  {/if}

  {#if dashboard.warnings.length}
    <TerminalAlert tone="warn" tag="GAP">
      {dashboard.warnings[0]}{dashboard.warnings.length > 1 ? ` (+${dashboard.warnings.length - 1} more)` : ''}
    </TerminalAlert>
  {/if}

  {#if payload}
    <section class="metric-grid" aria-label="Latest POL TVL values">
      <article class="metric metric--total">
        <span class="metric-label">TOTAL TRACKED VALUE</span>
        <strong>{formatPolTrackerUsd(latestTotal, true)}</strong>
        <small>synth backing + Treasury locked LP + both POL forms</small>
      </article>
      <article class="metric">
        <span class="metric-label">SYNTH BACKING</span>
        <strong>{formatPolTrackerUsd(latest?.synthBackingUsd, true)}</strong>
        <small>synth-unit pool share</small>
      </article>
      <article class="metric">
        <span class="metric-label">TREASURY LOCKED LP</span>
        <strong>{formatPolTrackerUsd(latest?.treasuryTotalUsd, true)}</strong>
        <small>locked module position</small>
      </article>
      <article class="metric">
        <span class="metric-label">RESERVE POL</span>
        <strong>{formatPolTrackerUsd(latest?.reservePolUsd, true)}</strong>
        <small>{formatPolTrackerRune(latest?.reservePolRune)} legacy-module gross</small>
      </article>
      <article class="metric">
        <span class="metric-label">SYSTEM INCOME POL{currentSystemIncomePol ? ' · LIVE' : ''}</span>
        <strong>{formatPolTrackerUsd(systemIncomePolUsd, true)}</strong>
        <small>{formatPolTrackerRune(systemIncomePolRune)} · FULL TWO-SIDED POSITION</small>
      </article>
      <article class="metric">
        <span class="metric-label">LATEST DAY</span>
        <strong class="text-value">{fullDate(latest?.day)}</strong>
        <small>height {latest?.height?.toLocaleString?.() || '—'}</small>
      </article>
      <article class="metric">
        <span class="metric-label">COVERAGE</span>
        <strong>{coveragePercent.toFixed(1)}%</strong>
        <small>{dashboard.coverage.observed_days || 0}/{dashboard.coverage.expected_days || 0} UTC days</small>
      </article>
      <article class="metric">
        <span class="metric-label">PARTIAL / MISSING</span>
        <strong>{(dashboard.coverage.partial_days || 0) + (dashboard.coverage.missing_days || 0)}</strong>
        <small>{dashboard.coverage.partial_days || 0} partial · {dashboard.coverage.missing_days || 0} missing</small>
      </article>
    </section>

    <div class="range-bar">
      <span>WINDOW</span>
      {#each POL_TRACKER_RANGES as range}
        <button class:active={rangeId === range.id} aria-pressed={rangeId === range.id} on:click={() => setRange(range.id)}>{range.label}</button>
      {/each}
      <button aria-label="Zoom in" on:click={() => chartHost?.zoomBy(0.65)}>[+]</button>
      <button aria-label="Zoom out" on:click={() => chartHost?.zoomBy(1.5)}>[−]</button>
      <span class="zoom-hint">DRAG TO ZOOM · DOUBLE-CLICK RESET</span>
      {#if isZoomed}
        <span class="zoom-window">{axisDate(rows[0]?.day)} — {axisDate(rows.at(-1)?.day)}</span>
        <button class="zoom-reset" on:click={resetZoom}>[R] RESET</button>
      {/if}
      <span class="selected-day">CURSOR {fullDate(selected?.day)}</span>
    </div>

    <section class="chart-panel">
      <div class="panel-heading">
        <div>
          <span class="prompt">$ plot</span>
          <h2>{chartGroup.title}</h2>
          <p>{chartGroup.description}</p>
        </div>
        <div class="legend" aria-label={`${chartGroup.title} cursor values`}>
          {#each POL_TRACKER_SERIES as series}
            <button class="legend-item" aria-pressed={!hiddenSeries.includes(series.id)} on:click={() => hiddenSeries = hiddenSeries.includes(series.id) ? hiddenSeries.filter(id => id !== series.id) : [...hiddenSeries, series.id]}>
              <span class="swatch" style={`--series-color:${series.color}`}></span>
              {series.label}
              <b>{formatPolTrackerUsd(series.value(selected), true)}</b>
            </button>
          {/each}
        </div>
      </div>

      <div class="chart-canvas">
        <TimeSeriesChart bind:this={chartHost} points={rangeRows} historyPoints={dashboard.daily} options={{ hidden: hiddenSeries }} onHiddenChange={ids => hiddenSeries = ids} buildOption={buildPolTrackerOption}
          {zoomWindow} onZoom={zoomChanged} onHover={(day) => hoveredDay = day}
          hasData={rangeRows.length > 0} {loading} height="320px" narrowHeight="300px"
          ariaLabel={chartGroup.title + ' daily stacked USD area chart. Drag horizontally to zoom; double-click to reset.'} />
      </div>
      <div class="inspect-day">
        <label for="pol-tvl-day">INSPECT UTC DAY</label>
        <select id="pol-tvl-day" bind:value={inspectedDay} on:change={() => hoveredDay = null}>
          <option value="">Latest visible day</option>
          {#each rows as row}
            <option value={row.day}>{row.day}</option>
          {/each}
        </select>
        <span>{fullDate(selected?.day)}</span>
        <span>TOTAL</span>
        <strong>{formatPolTrackerUsd(displayedTotal, true)}</strong>
      </div>
    </section>

    <section class="table-panel">
      <div class="panel-heading">
        <div>
          <span class="prompt">$ inspect --latest --by-pool</span>
          <h2>Latest pool breakdown</h2>
          <p>Only pools with synth backing, a locked Treasury position, or either form of POL are shown.</p>
        </div>
        <span class="row-count">{relevantPools.length} POOLS</span>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>POOL</th>
              <th>SYNTH BACKING</th>
              <th>TREASURY LOCKED LP</th>
              <th>RESERVE POL</th>
              <th>SYSTEM INCOME POL</th>
            </tr>
          </thead>
          <tbody>
            {#each relevantPools as pool}
              <tr>
                <td><strong>{pool.asset}</strong><small>{pool.status}</small></td>
                <td>{formatPolTrackerUsd(pool.synthBackingUsd, true)}</td>
                <td>{formatPolTrackerUsd(pool.treasuryTotalUsd, true)}</td>
                <td>
                  {formatPolTrackerUsd(pool.reservePolUsd, true)}
                  <small>{formatPolTrackerRune(pool.reservePolRune)}</small>
                </td>
                <td>
                  {formatPolTrackerUsd(pool.systemIncomePolUsd, true)}
                  <small>{formatPolTrackerRune(pool.systemIncomePolRune)}</small>
                </td>
              </tr>
            {:else}
              <tr><td colspan="5" class="empty">No per-pool observation is available yet.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="method-panel">
      <span class="prompt">$ methodology --accounting-boundaries</span>
      <p>
        All lanes use one historical block per completed UTC day. Synth backing is the pool share
        attributable to outstanding synth units. The tooltip total is the arithmetic sum of the four
        shaded areas: synth backing, Treasury locked LP, legacy Reserve POL, and the independently
        valued System Income POL position. RUNEPool ownership shares are absent.
      </p>
      <p class="source-line">TREASURY MODULE · …6r2p &nbsp;|&nbsp; LEGACY RESERVE · …xtxt &nbsp;|&nbsp; SYSTEM INCOME · POL_RESERVE &nbsp;|&nbsp; PRICES · SAME-HEIGHT TOR &nbsp;|&nbsp; GAPS · NEVER INTERPOLATED</p>
    </section>
  {/if}
</main>

<style>
  .pol-shell {
    max-width: 1500px;
    margin: 0 auto;
    padding: 28px 24px 72px;
    color: #e8e8e8;
    font-family: 'JetBrains Mono', monospace;
  }

  .terminal-header, .panel-heading, .range-bar, .header-state, .legend-item {
    display: flex;
    align-items: center;
  }

  .terminal-header {
    justify-content: space-between;
    gap: 24px;
    padding-bottom: 18px;
    border-bottom: 1px solid #333;
    margin-bottom: 16px;
  }

  .eyebrow, .prompt { color: #00cc66; }
  .eyebrow, .subtitle, .panel-heading p, .metric small, .source-line { margin: 0; font-size: 11px; }
  h1 { margin: 5px 0; font-size: clamp(26px, 4vw, 42px); letter-spacing: .08em; }
  h2 { margin: 4px 0; font-size: 15px; text-transform: uppercase; letter-spacing: .05em; }
  .subtitle, .panel-heading p, .metric small, .source-line { color: #888; }

  .header-state { gap: 8px; font-size: 11px; letter-spacing: .08em; }
  .state-dot { width: 7px; height: 7px; background: #00cc66; box-shadow: 0 0 8px rgba(0, 204, 102, .5); }
  .state-dot.stale { background: #d4a017; box-shadow: none; }
  button { font: inherit; }
  .refresh, .range-bar button {
    border: 1px solid #333;
    background: #080808;
    color: #c8c8c8;
    cursor: pointer;
  }
  .refresh { padding: 7px 9px; margin-left: 8px; font-size: 10px; }
  button:hover, .range-bar button.active { border-color: #00cc66; color: #00cc66; }
  button:disabled { cursor: wait; opacity: .6; }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border-left: 1px solid #1a1a1a;
    border-top: 1px solid #1a1a1a;
    margin: 16px 0;
  }
  .metric { min-height: 98px; padding: 15px; border-right: 1px solid #1a1a1a; border-bottom: 1px solid #1a1a1a; }
  .metric-label { display: block; color: #888; font-size: 10px; letter-spacing: .08em; }
  .metric strong { display: block; margin: 10px 0 4px; font-size: clamp(19px, 2vw, 28px); font-weight: 500; color: #fff; }
  .metric strong.text-value { font-size: 17px; }
  .metric--total {
    border-right-color: rgba(0, 204, 102, .45);
    border-bottom-color: rgba(0, 204, 102, .45);
    background: rgba(0, 204, 102, .08);
    box-shadow: inset 3px 0 0 #00cc66;
  }
  .metric--total .metric-label, .metric--total strong { color: #00cc66; }
  .metric--total small { color: #7fc49f; }

  .range-bar { flex-wrap: wrap; gap: 6px; padding: 10px 0; color: #777; font-size: 10px; }
  .range-bar button { min-width: 48px; padding: 6px 9px; font-size: 10px; }
  .zoom-hint { margin-left: auto; color: #777; }
  .zoom-window { color: #d8d8d8; }
  .range-bar .zoom-reset { color: #00cc66; border-color: rgba(0, 204, 102, .45); }
  .selected-day { color: #c8c8c8; }

  .chart-panel, .table-panel, .method-panel { border: 1px solid #1a1a1a; background: #080808; margin-top: 12px; }
  .panel-heading { justify-content: space-between; gap: 18px; padding: 13px 15px; border-bottom: 1px solid #1a1a1a; }
  .legend { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
  .legend-item { gap: 7px; padding: 6px 8px; border: 1px solid #262626; color: #aaa; font-size: 11px; }
  .legend-item { cursor: pointer; background: transparent; font-family: var(--term-font-mono); }
  .legend-item[aria-pressed=false] { opacity: .5; text-decoration: line-through; }
  .legend-item:focus-visible { outline: 1px solid var(--term-accent); outline-offset: 2px; }
  .legend-item b { color: #e8e8e8; font-weight: 500; }
  .swatch { width: 14px; height: 7px; background: var(--series-color); opacity: .72; }
  .chart-canvas { min-width: 0; padding: 4px 8px 0; }
  .inspect-day { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 15px; font-size: 11px; color: var(--term-text-3); }
  .inspect-day select { max-width: 100%; border: 1px solid var(--term-border); background: var(--term-surface); color: var(--term-text-body); font: inherit; padding: 5px; }
  .inspect-day strong { color: var(--term-accent); }

  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { padding: 11px 14px; text-align: right; border-bottom: 1px solid #141414; white-space: nowrap; }
  th { color: #777; font-size: 9px; font-weight: 500; letter-spacing: .08em; }
  th:first-child, td:first-child { text-align: left; }
  td strong, td small { display: block; }
  td small { margin-top: 3px; color: #666; font-size: 9px; }
  tbody tr:hover { background: #0d0d0d; }
  .row-count { color: #777; font-size: 10px; }
  .empty { padding: 28px; text-align: center !important; color: #777; }

  .method-panel { padding: 15px; font-size: 11px; line-height: 1.65; }
  .method-panel p { max-width: 1100px; margin: 8px 0 0; color: #aaa; }
  .method-panel .source-line { color: #666; }

  @media (max-width: 900px) {
    .pol-shell { padding: 18px 12px 56px; }
    .terminal-header, .panel-heading { align-items: flex-start; flex-direction: column; }
    .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .legend { justify-content: flex-start; }
  }

  @media (max-width: 520px) {
    .metric-grid { grid-template-columns: 1fr; }
    .zoom-hint, .selected-day { display: none; }
    .range-bar .zoom-reset { margin-left: auto; }
    .header-state { width: 100%; justify-content: space-between; }
  }
</style>
