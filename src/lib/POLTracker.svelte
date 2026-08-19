<script>
  import { onDestroy, onMount } from 'svelte';
  import TerminalAlert from './components/terminal/TerminalAlert.svelte';
  import { fetchPolTracker } from './pol-tracker/api.js';
  import {
    POL_TRACKER_GROUPS,
    POL_TRACKER_RANGES,
    POL_TRACKER_SERIES,
    buildPolTrackerChart,
    formatPolTrackerRune,
    formatPolTrackerUsd,
    normalizePolTrackerPayload,
    relevantPolTrackerPools,
    selectPolTrackerRange
  } from './pol-tracker/model.js';

  const REFRESH_MS = 5 * 60 * 1000;
  let payload = null;
  let loading = true;
  let refreshing = false;
  let loadError = '';
  let rangeId = 'all';
  let hiddenSeries = [];
  let hoverIndex = -1;
  let refreshTimer;

  $: dashboard = normalizePolTrackerPayload(payload || {});
  $: rows = selectPolTrackerRange(dashboard.daily, rangeId);
  $: charts = POL_TRACKER_GROUPS.map((group) => ({
    ...group,
    chart: buildPolTrackerChart(rows, group.id, { hiddenSeries })
  }));
  $: selected = rows[hoverIndex] || rows.at(-1) || null;
  $: relevantPools = relevantPolTrackerPools(dashboard.latestPools);
  $: latest = dashboard.latest;
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
      loadError = error?.message || 'POL Tracker history is unavailable.';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function setRange(nextRange) {
    rangeId = nextRange;
    hoverIndex = -1;
  }

  function toggleSeries(seriesId) {
    hiddenSeries = hiddenSeries.includes(seriesId)
      ? hiddenSeries.filter((id) => id !== seriesId)
      : [...hiddenSeries, seriesId];
  }

  function updateHover(event, chart) {
    if (!rows.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const relative = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    hoverIndex = Math.round(relative * Math.max(0, rows.length - 1));
  }

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

  function seriesForGroup(groupId) {
    return POL_TRACKER_SERIES.filter((series) => series.group === groupId);
  }
</script>

<svelte:head>
  <title>POL Tracker | BooneTools</title>
  <meta name="description" content="Daily THORChain Savers, synth backing, locked Treasury LP, Reserve POL, and Reserve-owned RUNEPool history." />
</svelte:head>

<main class="pol-shell">
  <header class="terminal-header">
    <div>
      <p class="eyebrow">$ boonetools pol-tracker --from 2025-02-01</p>
      <h1>POL TRACKER</h1>
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
    <section class="metric-grid" aria-label="Latest POL Tracker values">
      <article class="metric">
        <span class="metric-label">SAVERS</span>
        <strong>{formatPolTrackerUsd(latest?.saversUsd, true)}</strong>
        <small>same-height depth value</small>
      </article>
      <article class="metric">
        <span class="metric-label">SYNTH BACKING</span>
        <strong>{formatPolTrackerUsd(latest?.synthBackingUsd, true)}</strong>
        <small>synth-unit pool share</small>
      </article>
      <article class="metric">
        <span class="metric-label">TREASURY LOCKED LP</span>
        <strong>{formatPolTrackerUsd(latest?.treasuryTotalUsd, true)}</strong>
        <small>{formatPolTrackerUsd(latest?.treasuryAssetUsd, true)} asset + {formatPolTrackerUsd(latest?.treasuryRuneUsd, true)} RUNE</small>
      </article>
      <article class="metric">
        <span class="metric-label">RESERVE POL</span>
        <strong>{formatPolTrackerUsd(latest?.reservePolUsd, true)}</strong>
        <small>{formatPolTrackerRune(latest?.reservePolRune)} legacy-module gross</small>
      </article>
      <article class="metric">
        <span class="metric-label">RUNEPOOL · RESERVE SHARE</span>
        <strong>{formatPolTrackerUsd(latest?.runepoolReserveUsd, true)}</strong>
        <small>{formatPolTrackerRune(latest?.runepoolReserveRune)} · providers excluded</small>
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
        <button class:active={rangeId === range.id} on:click={() => setRange(range.id)}>{range.label}</button>
      {/each}
      <span class="selected-day">CURSOR {fullDate(selected?.day)}</span>
    </div>

    {#each charts as group}
      <section class="chart-panel">
        <div class="panel-heading">
          <div>
            <span class="prompt">$ plot</span>
            <h2>{group.title}</h2>
            <p>{group.description}</p>
          </div>
          <div class="legend" aria-label={`${group.title} series controls`}>
            {#each seriesForGroup(group.id) as series}
              <button
                class:disabled={hiddenSeries.includes(series.id)}
                on:click={() => toggleSeries(series.id)}
              >
                <span class="swatch" style={`--series-color:${series.color}`}></span>
                {series.label}
                <b>{formatPolTrackerUsd(series.value(selected), true)}</b>
              </button>
            {/each}
          </div>
        </div>

        <div class="chart-wrap">
          <svg viewBox={`0 0 ${group.chart.width} ${group.chart.height}`} role="img" aria-label={`${group.title} daily USD chart`}>
            {#each group.chart.yTicks as tick}
              <line x1={group.chart.plot.left} x2={group.chart.plot.right} y1={tick.y} y2={tick.y} class="grid-line" />
              <text x={group.chart.plot.left - 10} y={tick.y + 4} text-anchor="end" class="axis-label">
                {formatPolTrackerUsd(tick.value, true)}
              </text>
            {/each}
            {#each group.chart.xTicks as tick}
              <text x={tick.x} y={group.chart.height - 9} text-anchor="middle" class="axis-label">{axisDate(tick.day)}</text>
            {/each}
            {#each group.chart.paths as series}
              <path d={series.path} fill="none" stroke={series.color} stroke-width={series.id === 'treasury_total' ? 2.4 : 1.7} vector-effect="non-scaling-stroke" />
            {/each}
            {#if hoverIndex >= 0 && rows[hoverIndex]}
              <line
                x1={group.chart.x(hoverIndex)}
                x2={group.chart.x(hoverIndex)}
                y1={group.chart.plot.top}
                y2={group.chart.plot.bottom}
                class="cursor-line"
              />
            {/if}
            <rect
              role="presentation"
              x={group.chart.plot.left}
              y={group.chart.plot.top}
              width={group.chart.plot.right - group.chart.plot.left}
              height={group.chart.plot.bottom - group.chart.plot.top}
              fill="transparent"
              on:mousemove={(event) => updateHover(event, group.chart)}
              on:mouseleave={() => { hoverIndex = -1; }}
            />
          </svg>
        </div>
      </section>
    {/each}

    <section class="table-panel">
      <div class="panel-heading">
        <div>
          <span class="prompt">$ inspect --latest --by-pool</span>
          <h2>Latest pool breakdown</h2>
          <p>Only pools with a Saver, synth, or locked Treasury position are shown.</p>
        </div>
        <span class="row-count">{relevantPools.length} POOLS</span>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>POOL</th>
              <th>SAVERS</th>
              <th>SYNTH BACKING</th>
              <th>TREASURY ASSET</th>
              <th>TREASURY RUNE</th>
              <th>TREASURY TOTAL</th>
            </tr>
          </thead>
          <tbody>
            {#each relevantPools as pool}
              <tr>
                <td><strong>{pool.asset}</strong><small>{pool.status}</small></td>
                <td>{formatPolTrackerUsd(pool.saversUsd, true)}</td>
                <td>{formatPolTrackerUsd(pool.synthBackingUsd, true)}</td>
                <td>{formatPolTrackerUsd(pool.treasuryAssetUsd, true)}</td>
                <td>{formatPolTrackerUsd(pool.treasuryRuneUsd, true)}</td>
                <td>{formatPolTrackerUsd(pool.treasuryTotalUsd, true)}</td>
              </tr>
            {:else}
              <tr><td colspan="6" class="empty">No per-pool observation is available yet.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="method-panel">
      <span class="prompt">$ methodology --accounting-boundaries</span>
      <p>
        All lanes use one historical block per completed UTC day. Savers and synth backing overlap;
        Reserve POL and the RUNEPool Reserve share overlap. The provider-owned RUNEPool share is
        intentionally absent. These series must not be summed into a single “POL total.”
      </p>
      <p class="source-line">TREASURY MODULE · …6r2p &nbsp;|&nbsp; PRICES · SAME-HEIGHT TOR &nbsp;|&nbsp; GAPS · NEVER INTERPOLATED</p>
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

  .terminal-header, .panel-heading, .range-bar, .header-state, .legend button {
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
  .subtitle, .panel-heading p, .metric small, .axis-label, .source-line { color: #888; }

  .header-state { gap: 8px; font-size: 11px; letter-spacing: .08em; }
  .state-dot { width: 7px; height: 7px; background: #00cc66; box-shadow: 0 0 8px rgba(0, 204, 102, .5); }
  .state-dot.stale { background: #d4a017; box-shadow: none; }
  button { font: inherit; }
  .refresh, .range-bar button, .legend button {
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

  .range-bar { gap: 6px; padding: 10px 0; color: #777; font-size: 10px; }
  .range-bar button { min-width: 48px; padding: 6px 9px; font-size: 10px; }
  .selected-day { margin-left: auto; color: #c8c8c8; }

  .chart-panel, .table-panel, .method-panel { border: 1px solid #1a1a1a; background: #080808; margin-top: 12px; }
  .panel-heading { justify-content: space-between; gap: 18px; padding: 13px 15px; border-bottom: 1px solid #1a1a1a; }
  .legend { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
  .legend button { gap: 7px; padding: 6px 8px; font-size: 9px; }
  .legend button b { color: #e8e8e8; font-weight: 500; }
  .legend button.disabled { opacity: .35; text-decoration: line-through; }
  .swatch { width: 14px; height: 2px; background: var(--series-color); }
  .chart-wrap { padding: 4px 8px 0; overflow: hidden; }
  svg { display: block; width: 100%; min-width: 680px; }
  .grid-line { stroke: #171717; stroke-width: 1; vector-effect: non-scaling-stroke; }
  .axis-label { fill: #777; font: 10px 'JetBrains Mono', monospace; }
  .cursor-line { stroke: #555; stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }

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
    .chart-wrap { overflow-x: auto; }
  }

  @media (max-width: 520px) {
    .metric-grid { grid-template-columns: 1fr; }
    .selected-day { display: none; }
    .header-state { width: 100%; justify-content: space-between; }
  }
</style>
