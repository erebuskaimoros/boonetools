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
    projectPolTrackerChartSelection,
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
  let hoverIndex = -1;
  let zoomStartDay = '';
  let zoomEndDay = '';
  let selecting = false;
  let selectionStartX = null;
  let selectionEndX = null;
  let refreshTimer;

  $: dashboard = normalizePolTrackerPayload(payload || {});
  $: rangeRows = selectPolTrackerRange(dashboard.daily, rangeId);
  $: rows = zoomStartDay && zoomEndDay
    ? rangeRows.filter((row) => row.day >= zoomStartDay && row.day <= zoomEndDay)
    : rangeRows;
  $: isZoomed = Boolean(zoomStartDay && zoomEndDay && rows.length > 1) && (
    rows[0]?.day !== rangeRows[0]?.day || rows.at(-1)?.day !== rangeRows.at(-1)?.day
  );
  $: chartGroup = POL_TRACKER_GROUPS[0];
  $: chart = buildPolTrackerChart(rows, chartGroup.id);
  $: hovered = hoverIndex >= 0 ? rows[hoverIndex] || null : null;
  $: selected = hovered || rows.at(-1) || null;
  $: displayedTotal = totalPolTrackerValue(hovered);
  $: relevantPools = relevantPolTrackerPools(dashboard.latestPools);
  $: latest = dashboard.latest;
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
    resetZoom();
  }

  function resetZoom() {
    zoomStartDay = '';
    zoomEndDay = '';
    hoverIndex = -1;
    selecting = false;
    selectionStartX = null;
    selectionEndX = null;
  }

  function updateHover(event) {
    if (selecting || !rows.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const relative = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    hoverIndex = Math.round(relative * Math.max(0, rows.length - 1));
  }

  function pointerChartX(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const relative = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    return chart.plot.left + (relative * (chart.plot.right - chart.plot.left));
  }

  function startZoomSelection(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    hoverIndex = -1;
    selecting = true;
    selectionStartX = pointerChartX(event);
    selectionEndX = selectionStartX;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is optional; the selection still works inside the chart.
    }
  }

  function updateChartPointer(event) {
    if (!selecting) {
      updateHover(event);
      return;
    }
    selectionEndX = pointerChartX(event);
  }

  function finishZoomSelection(event) {
    if (!selecting) return;
    selectionEndX = pointerChartX(event);
    selecting = false;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // The browser may already have released this pointer.
    }

    const selection = projectPolTrackerChartSelection({
      rowCount: rows.length,
      plotLeft: chart.plot.left,
      plotRight: chart.plot.right,
      startX: selectionStartX,
      endX: selectionEndX
    });
    selectionStartX = null;
    selectionEndX = null;
    if (!selection) return;

    const selectedRows = rows.slice(selection.startIndex, selection.endIndex + 1);
    if (selectedRows.length < 2) return;
    if (selectedRows.length === rangeRows.length) {
      resetZoom();
      return;
    }
    zoomStartDay = selectedRows[0].day;
    zoomEndDay = selectedRows.at(-1).day;
    hoverIndex = -1;
  }

  function cancelZoomSelection(event) {
    selecting = false;
    selectionStartX = null;
    selectionEndX = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // The browser may already have released this pointer.
    }
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

</script>

<svelte:head>
  <title>POL TVL | BooneTools</title>
  <meta name="description" content="Daily THORChain synth backing, locked Treasury LP, and Reserve POL history." />
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
        <small>synth backing + Treasury locked LP + Reserve POL</small>
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
        <div class="legend" aria-label={`${chartGroup.title} series`}>
          {#each POL_TRACKER_SERIES as series}
            <span class="legend-item">
              <span class="swatch" style={`--series-color:${series.color}`}></span>
              {series.label}
              <b>{formatPolTrackerUsd(series.value(selected), true)}</b>
            </span>
          {/each}
        </div>
      </div>

      <div class="chart-scroll">
        <div class="chart-canvas">
          <svg
            viewBox={`0 0 ${chart.width} ${chart.height}`}
            role="img"
            aria-label={`${chartGroup.title} daily stacked USD area chart. Drag horizontally to zoom; double-click to reset.`}
            on:dblclick={resetZoom}
          >
            {#each chart.yTicks as tick}
              <line x1={chart.plot.left} x2={chart.plot.right} y1={tick.y} y2={tick.y} class="grid-line" />
              <text x={chart.plot.left - 10} y={tick.y + 4} text-anchor="end" class="axis-label">
                {formatPolTrackerUsd(tick.value, true)}
              </text>
            {/each}
            {#each chart.xTicks as tick}
              <text x={tick.x} y={chart.height - 9} text-anchor="middle" class="axis-label">{axisDate(tick.day)}</text>
            {/each}
            {#each chart.paths as series}
              <path d={series.areaPath} fill={series.color} class="area-fill" />
              <path d={series.path} fill="none" stroke={series.color} stroke-width="1.4" vector-effect="non-scaling-stroke" />
            {/each}
            {#if hoverIndex >= 0 && rows[hoverIndex]}
              <line
                x1={chart.x(hoverIndex)}
                x2={chart.x(hoverIndex)}
                y1={chart.plot.top}
                y2={chart.plot.bottom}
                class="cursor-line"
              />
            {/if}
            {#if selecting && selectionStartX !== null && selectionEndX !== null}
              <rect
                x={Math.min(selectionStartX, selectionEndX)}
                y={chart.plot.top}
                width={Math.abs(selectionEndX - selectionStartX)}
                height={chart.plot.bottom - chart.plot.top}
                class="zoom-selection"
              />
            {/if}
            <rect
              role="presentation"
              class="zoom-capture"
              x={chart.plot.left}
              y={chart.plot.top}
              width={chart.plot.right - chart.plot.left}
              height={chart.plot.bottom - chart.plot.top}
              fill="transparent"
              on:pointerdown={startZoomSelection}
              on:pointermove={updateChartPointer}
              on:pointerup={finishZoomSelection}
              on:pointercancel={cancelZoomSelection}
              on:mouseleave={() => { if (!selecting) hoverIndex = -1; }}
            />
          </svg>
          {#if hovered}
            <div
              class="chart-tooltip"
              class:align-right={chart.x(hoverIndex) > chart.width * 0.7}
              style={`--tooltip-x:${(chart.x(hoverIndex) / chart.width) * 100}%`}
            >
              <strong>{fullDate(hovered.day)}</strong>
              {#each POL_TRACKER_SERIES as series}
                <span class="tooltip-row">
                  <i style={`--series-color:${series.color}`}></i>
                  <span>{series.label}</span>
                  <b>{formatPolTrackerUsd(series.value(hovered), true)}</b>
                </span>
              {/each}
              <span class="tooltip-total">
                <span>TOTAL</span>
                <b>{formatPolTrackerUsd(displayedTotal, true)}</b>
              </span>
            </div>
          {/if}
        </div>
      </div>
    </section>

    <section class="table-panel">
      <div class="panel-heading">
        <div>
          <span class="prompt">$ inspect --latest --by-pool</span>
          <h2>Latest pool breakdown</h2>
          <p>Only pools with synth backing, a locked Treasury position, or Reserve POL are shown.</p>
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
              </tr>
            {:else}
              <tr><td colspan="4" class="empty">No per-pool observation is available yet.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="method-panel">
      <span class="prompt">$ methodology --accounting-boundaries</span>
      <p>
        All lanes use one historical block per completed UTC day. Synth backing is the pool share
        attributable to outstanding synth units. The tooltip total is the arithmetic sum of the three
        shaded areas: synth backing, Treasury locked LP, and Reserve POL. RUNEPool ownership shares
        are absent.
      </p>
      <p class="source-line">TREASURY MODULE · …6r2p &nbsp;|&nbsp; RESERVE MODULE · …xtxt &nbsp;|&nbsp; PRICES · SAME-HEIGHT TOR &nbsp;|&nbsp; GAPS · NEVER INTERPOLATED</p>
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
  .subtitle, .panel-heading p, .metric small, .axis-label, .source-line { color: #888; }

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
  .legend-item { gap: 7px; padding: 6px 8px; border: 1px solid #262626; color: #aaa; font-size: 9px; }
  .legend-item b { color: #e8e8e8; font-weight: 500; }
  .swatch { width: 14px; height: 7px; background: var(--series-color); opacity: .72; }
  .chart-scroll { padding: 4px 8px 0; overflow-x: auto; }
  .chart-canvas { position: relative; min-width: 680px; }
  svg { display: block; width: 100%; }
  .area-fill { opacity: .34; }
  .grid-line { stroke: #171717; stroke-width: 1; vector-effect: non-scaling-stroke; }
  .axis-label { fill: #777; font: 10px 'JetBrains Mono', monospace; }
  .cursor-line { stroke: #555; stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
  .zoom-selection { fill: rgba(0, 204, 102, .12); stroke: #00cc66; stroke-width: 1; vector-effect: non-scaling-stroke; pointer-events: none; }
  .zoom-capture { cursor: crosshair; touch-action: none; }
  .chart-tooltip {
    position: absolute;
    z-index: 2;
    top: 16px;
    left: var(--tooltip-x);
    min-width: 238px;
    padding: 10px;
    border: 1px solid #3a3a3a;
    background: rgba(5, 5, 5, .96);
    box-shadow: 0 8px 24px rgba(0, 0, 0, .45);
    transform: translateX(10px);
    pointer-events: none;
    font-size: 9px;
  }
  .chart-tooltip.align-right { transform: translateX(calc(-100% - 10px)); }
  .chart-tooltip > strong { display: block; margin-bottom: 7px; color: #fff; font-size: 10px; font-weight: 500; }
  .tooltip-row, .tooltip-total { display: grid; grid-template-columns: 8px 1fr auto; align-items: center; gap: 7px; padding: 3px 0; }
  .tooltip-row i { width: 7px; height: 7px; background: var(--series-color); }
  .tooltip-row span { color: #aaa; }
  .tooltip-row b, .tooltip-total b { color: #fff; font-weight: 500; }
  .tooltip-total { grid-template-columns: 1fr auto; margin-top: 6px; padding-top: 7px; border-top: 1px solid #333; color: #00cc66; }

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
