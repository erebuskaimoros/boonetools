<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import TerminalAlert from './components/terminal/TerminalAlert.svelte';
  import { getAssetLogo } from './constants/assets.js';
  import { fetchPoolAnalysis, fetchPoolAnalysisSeries } from './pool-analysis/api.js';
  import { renderPoolAnalysisCharts } from './pool-analysis/charts.js';
  import {
    POOL_ANALYSIS_RANGES,
    POOL_ANALYSIS_TABLE_PERIODS,
    baseToNumber,
    filterPoolAnalysisRows,
    formatPoolAnalysisNumber,
    formatPoolAnalysisPercent,
    formatPoolAnalysisUsd,
    normalizePoolAnalysisSeries,
    normalizePoolAnalysisSummary,
    poolAnalysisColumns,
    selectPoolAnalysisPeriod,
    sortPoolAnalysisRows
  } from './pool-analysis/model.js';

  const REFRESH_MS = 5 * 60 * 1000;
  const FALLBACK_LOGO = '/assets/coins/fallback-logo.svg';
  let payload = null;
  let selectedAsset = '';
  let selectedSeries = null;
  let rangeId = '30d';
  let tablePeriodId = '30d';
  let search = '';
  let statusFilter = 'available';
  let sort = { column: 'depthUsd', direction: 'desc' };
  let loading = true;
  let refreshing = false;
  let summaryError = '';
  let seriesLoading = false;
  let seriesError = '';
  let zoomWindow = null;
  let chartCanvas;
  let chartController;
  let refreshTimer;
  let seriesController;
  let seriesSequence = 0;
  const seriesCache = new Map();

  $: dashboard = normalizePoolAnalysisSummary(payload || {});
  $: tablePeriod = POOL_ANALYSIS_TABLE_PERIODS.find((period) => period.id === tablePeriodId)
    || POOL_ANALYSIS_TABLE_PERIODS[2];
  $: tableColumns = poolAnalysisColumns(tablePeriodId);
  $: tablePools = dashboard.pools.map((pool) => selectPoolAnalysisPeriod(pool, tablePeriodId));
  $: filteredPools = sortPoolAnalysisRows(
    filterPoolAnalysisRows(tablePools, { search, status: statusFilter }),
    sort
  );
  $: displayedPoints = selectedSeries?.asset === selectedAsset ? selectedSeries.points : [];

  onMount(() => {
    loadSummary();
    refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadSummary(true, true);
    }, REFRESH_MS);
  });

  onDestroy(() => {
    window.clearInterval(refreshTimer);
    seriesController?.abort();
    chartController?.destroy?.();
  });

  async function loadSummary(forceRefresh = false, silent = false) {
    if (refreshing) return;
    refreshing = true;
    if (!silent) loading = !payload;
    summaryError = '';
    try {
      payload = await fetchPoolAnalysis({ forceRefresh });
    } catch (error) {
      summaryError = error?.message || 'Pool Analysis snapshot could not be loaded';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function cacheKey(asset, range) {
    return `${asset}|${range}`;
  }

  async function loadSelectedSeries(asset, range, forceRefresh = false) {
    const key = cacheKey(asset, range);
    const cached = !forceRefresh ? seriesCache.get(key) : null;
    if (cached) {
      selectedSeries = cached;
      seriesError = '';
      zoomWindow = null;
      await drawCharts();
      return;
    }
    const sequence = ++seriesSequence;
    seriesController?.abort();
    seriesController = new AbortController();
    seriesLoading = true;
    seriesError = '';
    try {
      const result = normalizePoolAnalysisSeries(await fetchPoolAnalysisSeries(asset, range, {
        forceRefresh,
        signal: seriesController.signal
      }));
      if (sequence !== seriesSequence || asset !== selectedAsset || range !== rangeId) return;
      seriesCache.set(key, result);
      selectedSeries = result;
      zoomWindow = null;
      await drawCharts();
    } catch (error) {
      if (error?.name !== 'AbortError' && sequence === seriesSequence) {
        seriesError = error?.message || 'Pool daily history could not be loaded';
      }
    } finally {
      if (sequence === seriesSequence) seriesLoading = false;
    }
  }

  async function togglePool(asset) {
    if (selectedAsset === asset) {
      seriesController?.abort();
      selectedAsset = '';
      selectedSeries = null;
      seriesError = '';
      zoomWindow = null;
      chartController?.destroy?.();
      chartController = null;
      return;
    }
    chartController?.destroy?.();
    chartController = null;
    selectedAsset = asset;
    selectedSeries = null;
    rangeId = '30d';
    zoomWindow = null;
    await loadSelectedSeries(asset, rangeId);
  }

  async function selectRange(nextRange) {
    if (!selectedAsset || nextRange === rangeId && !seriesError) return;
    rangeId = nextRange;
    zoomWindow = null;
    await loadSelectedSeries(selectedAsset, nextRange);
  }

  async function drawCharts() {
    await tick();
    chartController?.destroy?.();
    chartController = null;
    if (!displayedPoints.length || !chartCanvas) return;
    chartController = renderPoolAnalysisCharts(chartCanvas, null, displayedPoints, {
      onZoom(window) { zoomWindow = window; }
    });
  }

  function resetZoom() {
    chartController?.resetZoom?.();
    zoomWindow = null;
  }

  function selectSort(columnId) {
    const column = tableColumns.find((candidate) => candidate.id === columnId);
    if (!column || column.sortable === false) return;
    sort = sort.column === columnId
      ? { column: columnId, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
      : { column: columnId, direction: column.defaultDirection };
  }

  function sortAria(columnId) {
    if (sort.column !== columnId) return 'none';
    return sort.direction === 'asc' ? 'ascending' : 'descending';
  }

  function sortIndicator(columnId) {
    if (sort.column !== columnId) return '↕';
    return sort.direction === 'asc' ? '↑' : '↓';
  }

  function detailId(asset) {
    return `pool-analysis-${asset.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  }

  function displayTimestamp(value) {
    const parsed = new Date(value || '');
    return Number.isFinite(parsed.getTime())
      ? `${parsed.toLocaleString('en-US', { timeZone: 'UTC', hour12: false })} UTC`
      : '—';
  }

  function displayDay(value) {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
      : '—';
  }

  function poolLogo(asset) {
    return getAssetLogo(asset) || FALLBACK_LOGO;
  }

  function useFallbackLogo(event) {
    if (event.currentTarget?.src?.endsWith(FALLBACK_LOGO)) return;
    event.currentTarget.src = FALLBACK_LOGO;
  }

  function balanceLabel(base, symbol) {
    const amount = baseToNumber(base);
    return amount === null ? '—' : `${formatPoolAnalysisNumber(amount, { compact: true })} ${symbol}`;
  }
</script>

<svelte:head>
  <title>THORChain Pool Analysis | BooneTools</title>
  <meta name="description" content="Compare THORChain pool liquidity, volume, pool-generated liquidity fees, annualized fee rates, and all-time daily fee history." />
</svelte:head>

<main class="pool-analysis">
  <header class="terminal-header">
    <div>
      <span class="eyebrow">THORCHAIN · LIQUIDITY INTELLIGENCE</span>
      <h1>POOL ANALYSIS</h1>
      <p>Current total pool liquidity and pricing consolidated with selectable pool-generated liquidity fees.</p>
    </div>
    <div class="header-status" class:refreshing class:stale={dashboard.stale}>
      <span class="status-dot"></span>
      <span>{refreshing ? 'RECONCILING' : dashboard.stale ? 'STALE MODEL' : 'LIVE SNAPSHOT'}</span>
      <small>{displayTimestamp(dashboard.asOf)}</small>
    </div>
  </header>

  {#if summaryError}
    <TerminalAlert tone="err" tag="ERR">
      {summaryError} <button class="inline-action" on:click={() => loadSummary(true)}>retry</button>
    </TerminalAlert>
  {/if}
  {#if dashboard.stale}
    <TerminalAlert tone="warn" tag="STALE">Serving the last successful Pool Analysis snapshot.</TerminalAlert>
  {/if}
  {#each dashboard.warnings as warning}
    <TerminalAlert tone="warn" tag="DATA">{warning}</TerminalAlert>
  {/each}

  <section class="table-panel" aria-labelledby="pool-table-title">
    <div class="panel-heading">
      <div>
        <span class="section-index">[01]</span>
        <h2 id="pool-table-title">POOL PERFORMANCE MATRIX</h2>
        <p>Activity covers {tablePeriod.label === '24H' ? 'the latest completed UTC day' : `${tablePeriod.days} completed UTC days`}. Pricing and two-sided depth are current.</p>
      </div>
      <div class="table-controls">
        <div class="period-picker">
          <span>WINDOW</span>
          <div class="period-control" role="group" aria-label="Table activity period">
            {#each POOL_ANALYSIS_TABLE_PERIODS as period}
              <button
                class:active={tablePeriodId === period.id}
                aria-pressed={tablePeriodId === period.id}
                on:click={() => tablePeriodId = period.id}
              >[{period.label}]</button>
            {/each}
          </div>
        </div>
        <label class="search-control">
          <span>FILTER</span>
          <input bind:value={search} type="search" placeholder="BTC.BTC" aria-label="Filter pools" />
        </label>
        <div class="status-control" role="group" aria-label="Pool status">
          {#each ['available', 'staged', 'all'] as status}
            <button
              class:active={statusFilter === status}
              aria-pressed={statusFilter === status}
              on:click={() => statusFilter = status}
            >[{status.toUpperCase()}]</button>
          {/each}
        </div>
      </div>
    </div>

    {#if loading && !dashboard.pools.length}
      <div class="loading-state" aria-live="polite">▓░░░░ SYNCING POOL SNAPSHOT<span>_</span></div>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr class="group-row">
              <th colspan="1">POOL</th>
              <th colspan="2">PRICING</th>
              <th colspan="2">LIQUIDITY</th>
              <th colspan="4">ACTIVITY · {tablePeriod.label}</th>
              <th colspan="1">ANNUALIZED</th>
            </tr>
            <tr class="column-row">
              {#each tableColumns as column}
                <th aria-sort={column.sortable === false ? undefined : sortAria(column.id)}>
                  {#if column.sortable === false}
                    <span class="static-head" title={column.label}>{column.label}</span>
                  {:else}
                    <button
                      class="sort-button"
                      class:active={sort.column === column.id}
                      title={column.label}
                      on:click={() => selectSort(column.id)}
                    >
                      <span>{column.label}</span><i>{sortIndicator(column.id)}</i>
                    </button>
                  {/if}
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each filteredPools as pool (pool.asset)}
              <tr class="pool-row" class:expanded={selectedAsset === pool.asset}>
                <td class="pool-cell" data-label="POOL">
                  <button
                    class="pool-toggle"
                    aria-expanded={selectedAsset === pool.asset}
                    aria-controls={detailId(pool.asset)}
                    on:click={() => togglePool(pool.asset)}
                  >
                    <span class="chevron">{selectedAsset === pool.asset ? '▾' : '▸'}</span>
                    <img src={poolLogo(pool.asset)} alt="" on:error={useFallbackLogo} />
                    <span class="pool-name">
                      <strong>{pool.symbol}</strong>
                      <small>{pool.asset}</small>
                    </span>
                    {#if pool.status.toLowerCase() === 'staged'}<em>STAGED</em>{/if}
                  </button>
                </td>
                <td class="number" data-label="USD PRICE" title={formatPoolAnalysisUsd(pool.priceUsd)}>{formatPoolAnalysisUsd(pool.priceUsd)}</td>
                <td class="number oracle-cell" data-label="ORACLE">
                  <span>{formatPoolAnalysisUsd(pool.oraclePriceUsd)}</span>
                  <small class:positive={pool.oracleDeviationPercent > 0} class:negative={pool.oracleDeviationPercent < 0}>
                    {formatPoolAnalysisPercent(pool.oracleDeviationPercent)}
                  </small>
                </td>
                <td class="number" data-label="DEPTH">{formatPoolAnalysisUsd(pool.depthUsd, { compact: true })}</td>
                <td class="balance-cell number" data-label="BALANCES">
                  <span>{balanceLabel(pool.balanceAssetBase, pool.symbol)}</span>
                  <small>{balanceLabel(pool.balanceRuneBase, 'RUNE')}</small>
                </td>
                <td class="number" data-label="VOLUME">{formatPoolAnalysisUsd(pool.periodVolumeUsd, { compact: true })}</td>
                <td class="number" data-label="FEES" class:coverage-warning={pool.coverage.missingDays > 0}>
                  {formatPoolAnalysisUsd(pool.periodFeesUsd, { compact: true })}
                  {#if pool.coverage.missingDays > 0}<small>{pool.coverage.observedDays}/{pool.coverage.expectedDays}D</small>{/if}
                </td>
                <td class="number" data-label="VOLUME / DEPTH">{formatPoolAnalysisPercent(pool.volumeDepthPercent)}</td>
                <td class="number" data-label="FEES / VOLUME">{formatPoolAnalysisPercent(pool.feeVolumePercent)}</td>
                <td class="number" data-label="EST APR">{formatPoolAnalysisPercent(pool.annualizedFeeRatePercent)}</td>
              </tr>
              {#if selectedAsset === pool.asset}
                <tr class="detail-row">
                  <td colspan={tableColumns.length}>
                    <section id={detailId(pool.asset)} class="detail-panel" aria-label={`${pool.asset} daily volume and fees`}>
                      <div class="detail-heading">
                        <div>
                          <span class="detail-kicker">{pool.asset} · DAILY HISTORY</span>
                          <h3>VOLUME + POOL-GENERATED LIQUIDITY FEES</h3>
                        </div>
                        <div class="range-copy">
                          <span>{displayDay(zoomWindow?.startDay || displayedPoints[0]?.day)} → {displayDay(zoomWindow?.endDay || displayedPoints.at(-1)?.day)}</span>
                          {#if zoomWindow}<b>CUSTOM ZOOM</b>{/if}
                        </div>
                      </div>

                      <div class="chart-controls" aria-label="Pool chart controls">
                        <div class="range-buttons">
                          {#each POOL_ANALYSIS_RANGES as range}
                            <button
                              class:active={!zoomWindow && rangeId === range.id}
                              aria-pressed={!zoomWindow && rangeId === range.id}
                              on:click={() => selectRange(range.id)}
                            >[{range.label}]</button>
                          {/each}
                        </div>
                        <div class="zoom-buttons" role="group" aria-label="Keyboard zoom controls">
                          <button aria-label="Zoom in" disabled={!displayedPoints.length} on:click={() => chartController?.zoomBy?.(0.6)}>[+]</button>
                          <button aria-label="Zoom out" disabled={!displayedPoints.length} on:click={() => chartController?.zoomBy?.(1.6)}>[-]</button>
                          <button class="reset" disabled={!zoomWindow} on:click={resetZoom}>[RESET ZOOM]</button>
                        </div>
                        <span class="zoom-hint">DRAG TO ZOOM · PINCH ON TOUCH · DOUBLE-CLICK TO RESET</span>
                      </div>

                      {#if seriesError}
                        <div class="chart-state error">
                          ERR · {seriesError}
                          <button on:click={() => loadSelectedSeries(pool.asset, rangeId, true)}>[R] RETRY</button>
                        </div>
                      {:else if seriesLoading && !displayedPoints.length}
                        <div class="chart-state" aria-live="polite">LOADING {pool.asset} DAILY HISTORY<span>_</span></div>
                      {:else if displayedPoints.length}
                        {#if seriesLoading}<div class="history-sync">SYNCING EARLIER HISTORY…</div>{/if}
                        <div class="chart-frame" role="group" aria-label={`${pool.asset} combined daily chart`} on:dblclick={resetZoom}>
                          <canvas
                            bind:this={chartCanvas}
                            aria-label={`${pool.asset} daily volume, daily pool-generated liquidity fees, and cumulative pool-generated liquidity fees in US dollars`}
                          ></canvas>
                        </div>
                      {:else}
                        <div class="chart-state">NO DAILY HISTORY AVAILABLE</div>
                      {/if}

                      {#if selectedSeries?.asset === pool.asset}
                        {#each selectedSeries.warnings as warning}
                          <div class="coverage-warning-line">WRN · {warning}</div>
                        {/each}
                        <footer class="detail-foot">
                          <span>BLUE · DAILY VOLUME</span>
                          <span>AMBER · DAILY FEES</span>
                          <span>GREEN · CUMULATIVE FEES</span>
                          <span>FIRST INDEXED · {selectedSeries.coverage.firstIndexedDay || '—'}</span>
                          <span>GAPS · {selectedSeries.coverage.missingDays.length}</span>
                          <span>USD FEES USE HISTORICAL DAILY RUNE PRICE</span>
                        </footer>
                      {/if}
                    </section>
                  </td>
                </tr>
              {/if}
            {:else}
              <tr><td class="empty-row" colspan={tableColumns.length}>NO POOLS MATCH CURRENT FILTERS</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      <footer class="table-foot">
        <span>{filteredPools.length} / {dashboard.pools.length} POOLS</span>
        <span>RUNE / USD · {formatPoolAnalysisUsd(dashboard.runePriceUsd)}</span>
        <span>{tablePeriod.label} THROUGH · {dashboard.period?.through_day || '—'}</span>
      </footer>
    {/if}
  </section>

  <footer class="method-line">
    <span>METHOD</span>
    <span>VOLUME = EXECUTED POOL LEGS</span>
    <span>VOLUME / DEPTH = AVG DAILY VOLUME / ONE-SIDED DEPTH</span>
    <span>FEES = POOL-GENERATED LIQUIDITY FEES</span>
    <span>EST APR = ANNUALIZED FEES / CURRENT TWO-SIDED DEPTH</span>
    <span>SYSTEM-INCOME DISTRIBUTION OUT OF SCOPE</span>
    <span>GAPS ARE NOT INTERPOLATED</span>
    <span>ALL TIMES UTC</span>
  </footer>
</main>

<style>
  :global(body) { background: var(--term-bg, #080808); }
  .pool-analysis { width: min(1600px, calc(100% - 40px)); margin: 0 auto; padding: 24px 0 56px; color: var(--term-text-body, #c8c8c8); }
  .terminal-header, .panel-heading, .table-controls, .period-picker, .period-control, .status-control, .detail-heading, .chart-controls, .range-buttons, .zoom-buttons, .table-foot, .detail-foot, .method-line { display: flex; align-items: center; }
  .terminal-header { justify-content: space-between; gap: 24px; padding: 24px 0 26px; border-bottom: 1px solid var(--term-border, #1a1a1a); }
  .eyebrow, h1, h2, h3, button, input, th, td, .header-status, .section-index, .detail-kicker, .range-copy, .table-foot, .detail-foot, .method-line { font-family: var(--term-font-mono, 'JetBrains Mono', monospace); }
  .eyebrow { color: var(--term-accent, #00cc66); font-size: 11px; font-weight: 700; letter-spacing: .12em; }
  h1 { margin: 7px 0 0; color: var(--term-text, #e8e8e8); font-size: clamp(24px, 3vw, 32px); letter-spacing: .07em; }
  .terminal-header p { margin: 9px 0 0; color: var(--term-text-3, #666); font-size: 13px; }
  .header-status { display: grid; grid-template-columns: 7px auto; gap: 4px 8px; justify-items: end; color: var(--term-accent, #00cc66); font-size: 11px; letter-spacing: .08em; }
  .header-status.stale { color: var(--term-amber, #d4a017); }
  .header-status.refreshing .status-dot { animation: pulse .9s steps(2) infinite; }
  .status-dot { width: 6px; height: 6px; background: currentColor; }
  .header-status small { grid-column: 1 / -1; color: var(--term-text-5, #444); font: inherit; letter-spacing: 0; }
  @keyframes pulse { 50% { opacity: .25; } }
  .inline-action { padding: 0; border: 0; background: none; color: inherit; text-decoration: underline; cursor: pointer; }

  .table-panel { margin-top: 18px; border: 1px solid var(--term-border, #1a1a1a); background: var(--term-surface, #0a0a0a); }
  .panel-heading { justify-content: space-between; gap: 24px; min-height: 66px; padding: 13px 16px 13px 18px; border-bottom: 1px solid var(--term-border, #1a1a1a); }
  .section-index { margin-right: 8px; color: var(--term-accent, #00cc66); font-size: 11px; }
  h2 { display: inline; margin: 0; color: var(--term-text, #e8e8e8); font-size: 12px; letter-spacing: .1em; }
  .panel-heading p { margin: 7px 0 0; color: var(--term-text-5, #444); font-size: 11px; }
  .table-controls { flex-wrap: wrap; justify-content: flex-end; gap: 8px 14px; }
  .period-picker, .search-control { gap: 7px; color: var(--term-text-5, #444); font: 11px var(--term-font-mono, 'JetBrains Mono', monospace); letter-spacing: .1em; }
  .search-control { display: flex; align-items: center; }
  .search-control input { width: 160px; min-height: 34px; padding: 7px 9px; border: 1px solid var(--term-border, #1a1a1a); border-radius: 0; outline: none; background: var(--term-surface-deep, #050505); color: var(--term-text-2, #888); font-size: 11px; text-transform: uppercase; }
  .search-control input:focus { border-color: rgba(0, 204, 102, .5); }
  .period-control, .status-control { gap: 3px; }
  .period-control button, .status-control button, .range-buttons button, .zoom-buttons button { min-height: 34px; padding: 6px 8px; border: 1px solid transparent; background: transparent; color: var(--term-text-4, #555); font-size: 11px; cursor: pointer; }
  .period-control button:hover, .period-control button.active, .status-control button:hover, .status-control button.active, .range-buttons button:hover, .range-buttons button.active, .zoom-buttons button:hover:not(:disabled) { border-color: var(--term-border, #1a1a1a); color: var(--term-accent, #00cc66); }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--term-accent, #00cc66); outline-offset: 2px; }
  button:disabled { opacity: .32; cursor: default; }
  .loading-state, .chart-state { min-height: 180px; display: grid; place-items: center; color: var(--term-info, #5588cc); font: 11px var(--term-font-mono, 'JetBrains Mono', monospace); letter-spacing: .08em; }
  .loading-state span, .chart-state span { animation: pulse .9s steps(2) infinite; }

  .table-scroll { max-width: 100%; overflow-x: auto; container-type: inline-size; scrollbar-color: var(--term-border-strong, #252525) var(--term-surface-deep, #050505); }
  table { width: 100%; min-width: 1000px; table-layout: fixed; border-collapse: collapse; }
  th { position: sticky; z-index: 3; padding: 0; border-right: 1px solid var(--term-border-faint, #111); border-bottom: 1px solid var(--term-border, #1a1a1a); background: var(--term-surface, #0a0a0a); color: var(--term-text-5, #444); font-size: 11px; white-space: nowrap; }
  .group-row th { top: 0; height: 27px; padding: 6px 12px; color: var(--term-text-6, #333); font-size: 10px; letter-spacing: .14em; text-align: center; }
  .column-row th { top: 27px; height: 39px; text-align: right; }
  .group-row th:first-child, .column-row th:first-child { position: sticky; left: 0; z-index: 5; width: 160px; text-align: left; }
  .sort-button, .static-head { display: flex; align-items: center; justify-content: flex-end; gap: 6px; width: 100%; min-height: 39px; box-sizing: border-box; padding: 8px 11px; overflow: hidden; border: 0; background: none; color: inherit; font-size: inherit; letter-spacing: .06em; white-space: nowrap; }
  .sort-button span, .static-head { overflow: hidden; text-overflow: ellipsis; }
  .column-row th:first-child .sort-button { justify-content: flex-start; padding-left: 14px; }
  .sort-button { cursor: pointer; }
  .sort-button:hover, .sort-button.active { color: var(--term-accent, #00cc66); }
  .sort-button i { min-width: 8px; color: var(--term-text-7, #222); font-style: normal; }
  .sort-button.active i { color: inherit; }
  td { height: 55px; padding: 9px 11px; border-right: 1px solid var(--term-border-faint, #111); border-bottom: 1px solid var(--term-border-faint, #111); color: var(--term-text-2, #888); font-size: 11px; text-align: right; white-space: nowrap; }
  .pool-row:hover, .pool-row.expanded { background: var(--term-surface-hover, #0d0d0d); }
  .pool-row.expanded td:first-child { box-shadow: inset 2px 0 0 var(--term-accent, #00cc66); }
  .pool-cell { position: sticky; left: 0; z-index: 2; width: 220px; padding: 0; background: inherit; text-align: left; }
  .pool-toggle { display: grid; grid-template-columns: 16px 25px minmax(0, 1fr) auto; align-items: center; gap: 7px; width: 100%; min-height: 54px; padding: 7px 11px; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
  .pool-toggle:hover strong { color: var(--term-accent, #00cc66); }
  .pool-toggle img { width: 23px; height: 23px; object-fit: contain; }
  .chevron { color: var(--term-accent, #00cc66); }
  .pool-name { min-width: 0; }
  .pool-name strong, .pool-name small { display: block; overflow: hidden; text-overflow: ellipsis; }
  .pool-name strong { color: var(--term-text, #e8e8e8); font-size: 11px; }
  .pool-name small { margin-top: 3px; color: var(--term-text-6, #333); font: 10px var(--term-font-mono, 'JetBrains Mono', monospace); }
  .pool-toggle em { padding: 2px 4px; border: 1px solid rgba(212, 160, 23, .35); color: var(--term-amber, #d4a017); font: normal 9px var(--term-font-mono, 'JetBrains Mono', monospace); }
  .number { font-variant-numeric: tabular-nums; }
  .oracle-cell span, .oracle-cell small, .balance-cell span, .balance-cell small, .coverage-warning small { display: block; }
  .oracle-cell small, .balance-cell small, .coverage-warning small { margin-top: 3px; color: var(--term-text-6, #333); font-size: 10px; }
  .oracle-cell small.positive { color: var(--term-accent, #00cc66); }
  .oracle-cell small.negative { color: var(--term-error, #dc3545); }
  .coverage-warning { color: var(--term-amber, #d4a017); }
  .empty-row { height: 100px; color: var(--term-text-5, #444); text-align: center; letter-spacing: .08em; }

  .detail-row > td { height: auto; padding: 0; background: var(--term-surface-deep, #050505); text-align: left; white-space: normal; }
  .detail-panel { position: sticky; left: 0; width: 100cqw; max-width: 100cqw; box-sizing: border-box; padding: 16px 18px 13px; }
  .detail-heading { justify-content: space-between; gap: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--term-border-faint, #111); }
  .detail-kicker { color: var(--term-accent, #00cc66); font-size: 10px; letter-spacing: .12em; }
  h3 { margin: 6px 0 0; color: var(--term-text, #e8e8e8); font-size: 12px; letter-spacing: .08em; }
  .range-copy { text-align: right; color: var(--term-text-4, #555); font-size: 10px; }
  .range-copy b { display: block; margin-top: 4px; color: var(--term-info, #5588cc); font-size: 10px; }
  .chart-controls { flex-wrap: wrap; gap: 6px 12px; min-height: 48px; }
  .range-buttons, .zoom-buttons { gap: 3px; }
  .zoom-buttons .reset { color: var(--term-info, #5588cc); }
  .zoom-hint { margin-left: auto; color: var(--term-text-6, #333); font: 10px var(--term-font-mono, 'JetBrains Mono', monospace); }
  .chart-state { min-height: 450px; border: 1px solid var(--term-border-faint, #111); }
  .chart-state.error { color: var(--term-error, #dc3545); }
  .chart-state button { margin-left: 9px; border: 0; background: none; color: inherit; cursor: pointer; }
  .history-sync { padding: 6px 9px; border-left: 2px solid var(--term-info, #5588cc); background: rgba(85, 136, 204, .06); color: var(--term-info, #5588cc); font: 10px var(--term-font-mono, 'JetBrains Mono', monospace); }
  .chart-frame { width: 100%; max-width: 100%; height: 500px; box-sizing: border-box; padding: 5px 4px 0; overflow: hidden; border: 1px solid var(--term-border-faint, #111); touch-action: pan-y; }
  .chart-frame canvas { width: 100% !important; height: 100% !important; }
  .coverage-warning-line { margin-top: 7px; padding: 6px 8px; border-left: 2px solid var(--term-amber, #d4a017); color: var(--term-amber, #d4a017); font: 10px var(--term-font-mono, 'JetBrains Mono', monospace); }
  .detail-foot { flex-wrap: wrap; gap: 7px 18px; padding-top: 10px; color: var(--term-text-6, #333); font-size: 10px; letter-spacing: .05em; }
  .detail-foot span:nth-child(1) { color: var(--term-info, #5588cc); }
  .detail-foot span:nth-child(2) { color: var(--term-amber, #d4a017); }
  .detail-foot span:nth-child(3) { color: var(--term-accent, #00cc66); }
  .table-foot { flex-wrap: wrap; justify-content: space-between; gap: 8px 18px; min-height: 39px; padding: 7px 16px; border-top: 1px solid var(--term-border-faint, #111); color: var(--term-text-6, #333); font-size: 10px; letter-spacing: .06em; }
  .method-line { flex-wrap: wrap; gap: 10px 18px; margin-top: 13px; padding: 9px 0; border-top: 1px solid var(--term-border-faint, #111); color: var(--term-text-6, #333); font-size: 10px; }
  .method-line span:first-child { color: var(--term-accent, #00cc66); font-weight: 800; }

  @container (max-width: 900px) {
    table { display: block; min-width: 0; table-layout: auto; }
    thead { display: none; }
    tbody { display: block; padding: 8px; }
    .pool-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 8px; border: 1px solid var(--term-border, #1a1a1a); background: var(--term-surface, #0a0a0a); }
    .pool-row:first-child { margin-top: 0; }
    .pool-row td { position: static; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; width: auto; min-width: 0; height: auto; min-height: 42px; padding: 8px 10px; border-right: 1px solid var(--term-border-faint, #111); white-space: normal; overflow-wrap: anywhere; }
    .pool-row td:nth-child(even) { border-right: 0; }
    .pool-row td::before { content: attr(data-label); min-width: 0; color: var(--term-text-5, #444); font-size: 9px; letter-spacing: .06em; text-align: left; }
    .pool-row .pool-cell { grid-column: 1 / -1; display: block; border-right: 0; background: var(--term-surface-hover, #0d0d0d); }
    .pool-row .pool-cell::before { display: none; }
    .pool-row.expanded .pool-cell { box-shadow: inset 2px 0 0 var(--term-accent, #00cc66); }
    .pool-toggle { min-height: 50px; }
    .pool-row td > * { min-width: 0; }
    .detail-row { display: block; }
    .detail-row > td { display: block; width: auto; border-right: 0; }
    .detail-panel { width: 100%; max-width: 100%; padding: 13px 10px; }
    tbody > tr:not(.pool-row):not(.detail-row) { display: block; }
    .empty-row { display: block; width: auto; }
  }

  @media (max-width: 900px) {
    .terminal-header, .panel-heading { align-items: flex-start; flex-direction: column; }
    .header-status { justify-items: start; }
    .table-controls { justify-content: flex-start; }
    .detail-panel { padding: 13px 10px; }
    .zoom-hint { width: 100%; margin-left: 0; }
  }
  @media (max-width: 640px) {
    .pool-analysis { width: calc(100% - 24px); padding-top: 14px; }
    .terminal-header { padding-top: 15px; }
    .panel-heading { padding: 12px; }
    .search-control input { width: 132px; }
    .period-picker { align-items: flex-start; flex-direction: column; }
    .period-control button, .status-control button, .range-buttons button, .zoom-buttons button { min-height: 40px; }
    .group-row th:first-child, .column-row th:first-child, .pool-cell { width: 146px; min-width: 146px; max-width: 146px; }
    .pool-toggle { grid-template-columns: 13px 22px minmax(0, 1fr); padding-left: 7px; }
    .pool-toggle em { display: none; }
    .pool-toggle img { width: 20px; height: 20px; }
    .detail-heading { align-items: flex-start; flex-direction: column; }
    .range-copy { text-align: left; }
    .chart-frame { height: 470px; }
  }
</style>
