<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import { fetchTcFeeDash } from './tc-fee-dash/api.js';
  import { clearCoreSnapshotCache } from '$lib/api/core-snapshot.js';
  import { fetchJSONWithFallback } from '$lib/utils/api.js';
  import {
    aggregateTcFeeRows,
    buildIncomeVolumeRollingAverageSeries,
    buildRollingAverageSeries,
    buildTcFeeChartSeries,
    normalizeTcFeeRows,
    summarizeTcFeeRows
  } from './tc-fee-dash/model.js';
  import { formatNumber, formatUSD } from '$lib/utils/formatting';
  import { TerminalAlert } from '$lib/components/terminal';
  import {
    createSystemIncomeDistributionChart,
    createTcFeeChart,
    createTcFeeIncomeVolumeChart,
    drawTcFeeNavigator,
    tcFeeNavigatorIndexFromPixel
  } from './tc-fee-dash/charts.js';
  import {
    formatTcFeeBps as formatBps,
    formatTcFeeDate as formatDate,
    formatTcFeeUsdCompact as formatUsdCompact
  } from './tc-fee-dash/presentation.js';
  import {
    buildSystemIncomeDistribution,
    formatSystemIncomePercent,
    systemIncomeDistributionFlows
  } from './tc-fee-dash/distribution.js';

  const GRANULARITIES = [
    { value: 'day', label: 'day' },
    { value: 'week', label: 'week' },
    { value: 'month', label: 'month' }
  ];
  const ROLLING_AVERAGES = [
    { days: 30, label: '30d', color: '#d4a017', dash: [4, 4] },
    { days: 90, label: '90d', color: '#5588cc', dash: [8, 5] },
    { days: 180, label: '180d', color: '#c8c8c8', dash: [2, 5] }
  ];
  let dashboard = null;
  let loading = true;
  let refreshing = false;
  let error = '';
  let systemIncomeDistribution = buildSystemIncomeDistribution();
  let distributionLoading = true;
  let distributionRefreshing = false;
  let distributionError = '';
  let distributionCanvas;
  let distributionChartInstance;
  let chartCanvas;
  let chartShell;
  let incomeVolumeCanvas;
  let incomeVolumeChartShell;
  let incomeVolumeChartInstance;
  let navCanvas;
  let chartInstance;
  let resizeTimer;
  let renderTimer;
  let granularity = 'day';
  let rollingAverageState = { 30: false, 90: false, 180: false };
  let windowStartIndex = 0;
  let windowEndIndex = 0;
  let rangeInitialized = false;
  let brush = { active: false, chartType: 'fees', startX: 0, currentX: 0 };
  let navDrag = null;

  $: rows = normalizeTcFeeRows(dashboard?.rows || []);
  $: maxWindowIndex = Math.max(0, rows.length - 1);
  $: if (rows.length && !rangeInitialized) {
    windowStartIndex = 0;
    windowEndIndex = maxWindowIndex;
    rangeInitialized = true;
  }
  $: normalizedStartIndex = Math.max(0, Math.min(Number(windowStartIndex) || 0, maxWindowIndex));
  $: normalizedEndIndex = Math.max(normalizedStartIndex, Math.min(Number(windowEndIndex) || 0, maxWindowIndex));
  $: selectedRows = rows.slice(normalizedStartIndex, normalizedEndIndex + 1);
  $: displayRows = aggregateTcFeeRows(selectedRows, granularity);
  $: series = buildTcFeeChartSeries(displayRows);
  $: hasIncomeVolumeData = displayRows.some((row) => row.thorchainVolumeUsd != null);
  $: activeRollingAverages = ROLLING_AVERAGES.filter((option) => rollingAverageState[option.days]);
  $: rollingSeries = activeRollingAverages.map((option) => ({
    ...option,
    data: buildRollingAverageSeries(rows, displayRows, option.days)
  }));
  $: incomeVolumeRollingSeries = activeRollingAverages.map((option) => ({
    ...option,
    data: buildIncomeVolumeRollingAverageSeries(rows, displayRows, option.days)
  }));
  $: summary = summarizeTcFeeRows(displayRows);
  $: latest = summary.latest || displayRows.at(-1) || null;
  $: peak = summary.peak || null;
  $: selectedStartRow = rows[normalizedStartIndex] || null;
  $: selectedEndRow = rows[normalizedEndIndex] || null;
  $: isFullWindow = rows.length > 0 && normalizedStartIndex === 0 && normalizedEndIndex === maxWindowIndex;
  $: distributionFlows = systemIncomeDistributionFlows(systemIncomeDistribution);
  $: hasDashboardError = Boolean(error || distributionError);
  $: isDashboardLoading = loading || distributionLoading;
  $: isDashboardRefreshing = refreshing || distributionRefreshing;

  $: if (typeof window !== 'undefined' && navCanvas && rows.length >= 0) {
    void normalizedStartIndex;
    void normalizedEndIndex;
    void rows;
    requestAnimationFrame(drawNavigator);
  }

  onMount(() => {
    window.addEventListener('resize', handleResize);
    loadDashboard();
    loadSystemIncomeDistribution();
  });

  onDestroy(() => {
    window.removeEventListener('resize', handleResize);
    window.removeEventListener('mousemove', chartBrushMove);
    window.removeEventListener('mouseup', chartBrushUp);
    clearTimeout(resizeTimer);
    clearTimeout(renderTimer);
    destroyCharts();
  });

  async function loadDashboard(options = {}) {
    loading = !dashboard;
    refreshing = Boolean(dashboard);
    error = '';

    try {
      dashboard = await fetchTcFeeDash({ forceRefresh: options.forceRefresh !== false });
      loading = false;
      refreshing = false;
      await tick();
      renderCharts();
    } catch (loadError) {
      error = loadError.message || String(loadError);
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function loadSystemIncomeDistribution(options = {}) {
    distributionLoading = !systemIncomeDistribution.complete;
    distributionRefreshing = systemIncomeDistribution.complete;
    distributionError = '';

    try {
      if (options.forceRefresh) clearCoreSnapshotCache();
      const [mimir, constants] = await Promise.all([
        fetchJSONWithFallback('/thorchain/mimir'),
        fetchJSONWithFallback('/thorchain/constants')
      ]);
      systemIncomeDistribution = buildSystemIncomeDistribution(mimir, constants);
      if (!systemIncomeDistribution.complete) {
        throw new Error('one or more allocation levers are unavailable');
      }
      await tick();
      renderSystemIncomeDistributionChart();
    } catch (loadError) {
      distributionError = loadError.message || String(loadError);
    } finally {
      distributionLoading = false;
      distributionRefreshing = false;
    }
  }

  function refreshDashboard() {
    loadDashboard({ forceRefresh: true });
    loadSystemIncomeDistribution({ forceRefresh: true });
  }

  function destroyChart() {
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
  }

  function destroyIncomeVolumeChart() {
    if (incomeVolumeChartInstance) {
      incomeVolumeChartInstance.destroy();
      incomeVolumeChartInstance = null;
    }
  }

  function destroySystemIncomeDistributionChart() {
    if (distributionChartInstance) {
      distributionChartInstance.destroy();
      distributionChartInstance = null;
    }
  }

  function destroyCharts() {
    destroyChart();
    destroyIncomeVolumeChart();
    destroySystemIncomeDistributionChart();
  }

  function handleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderCharts();
      drawNavigator();
    }, 150);
  }

  function queueRenderChart() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderCharts();
    }, 0);
  }

  function clampWindowIndex(value) {
    return Math.max(0, Math.min(Number(value) || 0, maxWindowIndex));
  }

  function setGranularity(value) {
    granularity = value;
    queueRenderChart();
  }

  function toggleRollingAverage(days) {
    rollingAverageState = {
      ...rollingAverageState,
      [days]: !rollingAverageState[days]
    };
    queueRenderChart();
  }

  function setWindowStart(value) {
    windowStartIndex = Math.min(clampWindowIndex(value), normalizedEndIndex);
    queueRenderChart();
  }

  function setWindowEnd(value) {
    windowEndIndex = Math.max(clampWindowIndex(value), normalizedStartIndex);
    queueRenderChart();
  }

  function resetWindow() {
    windowStartIndex = 0;
    windowEndIndex = maxWindowIndex;
    queueRenderChart();
  }

  function drawNavigator() {
    drawTcFeeNavigator(navCanvas, rows, normalizedStartIndex, normalizedEndIndex);
  }

  function navIndexFromPx(px, width) {
    return tcFeeNavigatorIndexFromPixel(px, width, rows.length);
  }

  function navMouseDown(event) {
    if (!rows.length || !navCanvas) return;
    const rect = navCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const w = rect.width;
    const max = Math.max(1, rows.length - 1);
    const startX = (normalizedStartIndex / max) * w;
    const endX = (normalizedEndIndex / max) * w;
    const HANDLE = 8;
    let kind;
    if (Math.abs(x - startX) <= HANDLE) kind = 'left';
    else if (Math.abs(x - endX) <= HANDLE) kind = 'right';
    else if (x > startX && x < endX) kind = 'window';
    else {
      if (x < startX) {
        windowStartIndex = navIndexFromPx(x, w);
        kind = 'left';
      } else {
        windowEndIndex = navIndexFromPx(x, w);
        kind = 'right';
      }
      queueRenderChart();
    }
    navDrag = {
      kind,
      startX: x,
      width: w,
      origStart: normalizedStartIndex,
      origEnd: normalizedEndIndex
    };
    window.addEventListener('mousemove', navMouseMove);
    window.addEventListener('mouseup', navMouseUp);
    event.preventDefault();
  }

  function navMouseMove(event) {
    if (!navDrag) return;
    const rect = navCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const w = navDrag.width;
    const max = Math.max(1, rows.length - 1);
    if (navDrag.kind === 'left') {
      windowStartIndex = Math.min(navIndexFromPx(x, w), normalizedEndIndex);
    } else if (navDrag.kind === 'right') {
      windowEndIndex = Math.max(navIndexFromPx(x, w), normalizedStartIndex);
    } else if (navDrag.kind === 'window') {
      const dx = x - navDrag.startX;
      const dIdx = Math.round((dx / w) * max);
      const span = navDrag.origEnd - navDrag.origStart;
      let newStart = Math.max(0, Math.min(navDrag.origStart + dIdx, max - span));
      windowStartIndex = newStart;
      windowEndIndex = newStart + span;
    }
    queueRenderChart();
  }

  function navMouseUp() {
    navDrag = null;
    window.removeEventListener('mousemove', navMouseMove);
    window.removeEventListener('mouseup', navMouseUp);
  }

  function navHoverCursor(event) {
    if (!navCanvas || !rows.length) return;
    const rect = navCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const w = rect.width;
    const max = Math.max(1, rows.length - 1);
    const startX = (normalizedStartIndex / max) * w;
    const endX = (normalizedEndIndex / max) * w;
    const HANDLE = 8;
    if (Math.abs(x - startX) <= HANDLE || Math.abs(x - endX) <= HANDLE) {
      navCanvas.style.cursor = 'ew-resize';
    } else if (x > startX && x < endX) {
      navCanvas.style.cursor = navDrag ? 'grabbing' : 'grab';
    } else {
      navCanvas.style.cursor = 'crosshair';
    }
  }

  function getChartBrushTarget(chartType = 'fees') {
    return chartType === 'income-volume'
      ? {
          instance: incomeVolumeChartInstance,
          canvas: incomeVolumeCanvas,
          shell: incomeVolumeChartShell
        }
      : { instance: chartInstance, canvas: chartCanvas, shell: chartShell };
  }

  function chartBrushDown(event, chartType = 'fees') {
    const target = getChartBrushTarget(chartType);
    if (!target.instance || !target.shell) return;
    if (event.button !== 0) return;
    const rect = target.shell.getBoundingClientRect();
    const x = event.clientX - rect.left;
    brush = { active: true, chartType, startX: x, currentX: x };
    window.addEventListener('mousemove', chartBrushMove);
    window.addEventListener('mouseup', chartBrushUp);
    event.preventDefault();
  }

  function chartBrushMove(event) {
    const target = getChartBrushTarget(brush.chartType);
    if (!brush.active || !target.shell) return;
    const rect = target.shell.getBoundingClientRect();
    brush = { ...brush, currentX: event.clientX - rect.left };
  }

  function chartBrushUp() {
    if (!brush.active) {
      window.removeEventListener('mousemove', chartBrushMove);
      window.removeEventListener('mouseup', chartBrushUp);
      return;
    }
    const dragged = Math.abs(brush.currentX - brush.startX) > 4;
    const sx = Math.min(brush.startX, brush.currentX);
    const ex = Math.max(brush.startX, brush.currentX);
    const chartType = brush.chartType;
    brush = { active: false, chartType: 'fees', startX: 0, currentX: 0 };
    window.removeEventListener('mousemove', chartBrushMove);
    window.removeEventListener('mouseup', chartBrushUp);
    if (dragged) applyChartBrush(sx, ex, chartType);
  }

  function applyChartBrush(sx, ex, chartType = 'fees') {
    const target = getChartBrushTarget(chartType);
    if (!target.instance || !target.canvas || !target.shell) return;
    const canvasRect = target.canvas.getBoundingClientRect();
    const shellRect = target.shell.getBoundingClientRect();
    const offsetX = canvasRect.left - shellRect.left;
    const xScale = target.instance.scales.x;
    if (!xScale) return;
    const lo = Math.max(xScale.left, Math.min(sx - offsetX, xScale.right));
    const hi = Math.max(xScale.left, Math.min(ex - offsetX, xScale.right));
    const startDispIdx = Math.round(xScale.getValueForPixel(lo));
    const endDispIdx = Math.round(xScale.getValueForPixel(hi));
    const lo2 = Math.max(0, Math.min(startDispIdx, displayRows.length - 1));
    const hi2 = Math.max(lo2, Math.min(endDispIdx, displayRows.length - 1));
    if (lo2 === hi2) return;
    const startDate = String(displayRows[lo2]?.windowStart || '');
    const endDate = String(displayRows[hi2]?.windowStart || '');
    if (!startDate || !endDate) return;
    let newStart = rows.findIndex((r) => String(r.windowStart) >= startDate);
    if (newStart === -1) newStart = 0;
    const nextAfter = rows.findIndex((r) => String(r.windowStart) > endDate);
    const newEnd = nextAfter === -1 ? rows.length - 1 : Math.max(newStart, nextAfter - 1);
    windowStartIndex = newStart;
    windowEndIndex = newEnd;
    queueRenderChart();
  }

  function chartDblClick() {
    resetWindow();
  }

  function renderCharts() {
    renderChart();
    renderIncomeVolumeChart();
    renderSystemIncomeDistributionChart();
  }

  function renderChart() {
    if (!chartCanvas || !series.rows.length) {
      destroyChart();
      return;
    }
    destroyChart();
    chartInstance = createTcFeeChart(chartCanvas, { series, rollingSeries });
  }

  function renderIncomeVolumeChart() {
    if (!incomeVolumeCanvas || !series.rows.length || !hasIncomeVolumeData) {
      destroyIncomeVolumeChart();
      return;
    }
    destroyIncomeVolumeChart();
    incomeVolumeChartInstance = createTcFeeIncomeVolumeChart(incomeVolumeCanvas, {
      series,
      rollingSeries: incomeVolumeRollingSeries
    });
  }

  function renderSystemIncomeDistributionChart() {
    if (!distributionCanvas || !distributionFlows.length) {
      destroySystemIncomeDistributionChart();
      return;
    }
    destroySystemIncomeDistributionChart();
    distributionChartInstance = createSystemIncomeDistributionChart(
      distributionCanvas,
      distributionFlows
    );
  }

</script>

<div class="tc-fee-dashboard">
  <div class="dash-head">
    <div class="head-top">
      <div class="head-left">
        <span class="prompt">$</span>
        <span class="cmd">tc-fees</span>
        <span class="arg">--denom cmc-plus-dune</span>
      </div>
      <div class="head-right">
        <span class="status">
          <span class="dot" class:warn={hasDashboardError} class:ok={!hasDashboardError && !isDashboardLoading}></span>
          {hasDashboardError ? 'DEGRADED' : isDashboardLoading ? 'SYNCING' : 'LIVE'}
        </span>
        <span class="sep">│</span>
        <button class="refresh" on:click={refreshDashboard} disabled={isDashboardRefreshing}>
          <span class="bracket">[</span><span class="key">R</span><span class="bracket">]</span>
          {isDashboardRefreshing ? 'refreshing' : 'refresh'}
        </button>
      </div>
    </div>
    <h1 class="title">TC FEE <span class="accent">CAPTURE</span><span class="cursor">_</span></h1>
    <p class="lede">
      Protocol fee-capture efficiency — THORChain system fees collected per $1B of global
      exchange volume (CoinMarketCap spot + Dune DEX), with native income-to-volume yield
      shown below. Higher values mean the network is extracting more revenue per unit of activity.
    </p>
    <div class="rule"></div>
  </div>

  {#if error}
    <div class="alerts">
      <TerminalAlert tone="err">tc fee series — {error}</TerminalAlert>
    </div>
  {/if}

  {#if distributionError}
    <div class="alerts">
      <TerminalAlert tone="warn">system income distribution — {distributionError}</TerminalAlert>
    </div>
  {/if}

  {#if rows.length}
    <div class="metric-grid">
      <article class="metric">
        <div class="metric-head">
          <span class="metric-idx">01</span>
          <span class="metric-label">weighted / $1B</span>
        </div>
        <strong class="metric-value">{formatUSD(summary.weightedFeesPerBillionUsd || 0)}</strong>
        <small class="metric-foot">across {summary.windowCount || rows.length} windows</small>
      </article>
      <article class="metric">
        <div class="metric-head">
          <span class="metric-idx">02</span>
          <span class="metric-label">latest / $1B</span>
        </div>
        <strong class="metric-value">{latest ? formatUSD(latest.feesPerBillionUsd) : '—'}</strong>
        <small class="metric-foot">{latest ? formatDate(latest.windowStart) : 'no data'}</small>
      </article>
      <article class="metric">
        <div class="metric-head">
          <span class="metric-idx">03</span>
          <span class="metric-label">peak / $1B</span>
        </div>
        <strong class="metric-value metric-value--amber">{peak ? formatUSD(peak.feesPerBillionUsd) : '—'}</strong>
        <small class="metric-foot">{peak ? formatDate(peak.windowStart) : 'no data'}</small>
      </article>
      <article class="metric">
        <div class="metric-head">
          <span class="metric-idx">04</span>
          <span class="metric-label">total tc fees</span>
        </div>
        <strong class="metric-value">{formatUsdCompact(summary.totalTcFeesUsd || 0)}</strong>
        <small class="metric-foot">on {formatUsdCompact(summary.totalGlobalExchangeVolumeUsd || 0)} volume</small>
      </article>
    </div>
  {/if}

  <section class="distribution-section" aria-labelledby="system-income-distribution-title">
    <div class="distribution-section-head">
      <div class="block-title" id="system-income-distribution-title">
        <span class="block-marker">▌</span>
        <span>SYSTEM INCOME DISTRIBUTION</span>
      </div>
      <div class="meta-strip">
        <span>[CURRENT]</span>
        <span>POST-REVSHARE</span>
        <span>10,000 BPS</span>
      </div>
    </div>

    <div class="distribution-grid">
      <article class="distribution-card distribution-card--allocations">
        <div class="block-head distribution-card-head">
          <div class="block-title">
            <span class="card-index">05A</span>
            <span>ACTIVE ALLOCATION</span>
          </div>
          <div class="meta-strip"><span>[MIMIR + DEFAULTS]</span></div>
        </div>

        <p class="distribution-note">
          Active Mimirs override compiled protocol defaults. Burn, Dev, TCY, Marketing, and POL
          are explicit deductions; Bond Providers receive the remainder.
        </p>

        {#if distributionLoading && !systemIncomeDistribution.complete}
          <div class="distribution-state">
            <div class="loader-bar"><span></span></div>
            <span>RESOLVING ACTIVE MIMIRS</span>
          </div>
        {:else if systemIncomeDistribution.complete}
          <div class="allocation-list" role="list" aria-label="Current system income allocations">
            {#each systemIncomeDistribution.allocations as allocation}
              <div
                class="allocation-row"
                style="--allocation-color: {allocation.color}; --allocation-width: {Math.min(100, allocation.percent || 0)}%;"
                role="listitem"
              >
                <div class="allocation-main">
                  <span class="allocation-swatch" aria-hidden="true"></span>
                  <span class="allocation-name">{allocation.label}</span>
                  <span class="allocation-source" class:allocation-source--mimir={allocation.source === 'mimir'}>
                    [{allocation.source === 'constant' ? 'DEFAULT' : allocation.source.toUpperCase()}]
                  </span>
                </div>
                <strong class="allocation-value">{formatSystemIncomePercent(allocation.percent)}</strong>
                <span class="allocation-key">
                  {allocation.mimirKey || '10,000 BPS − EXPLICIT LANES'}
                </span>
                <div class="allocation-track" aria-hidden="true"><span></span></div>
              </div>
            {/each}
          </div>
          {#if systemIncomeDistribution.overflowBps > 0}
            <p class="distribution-warning">
              WRN · EXPLICIT ALLOCATIONS EXCEED 10,000 BPS BY {systemIncomeDistribution.overflowBps} BPS
            </p>
          {/if}
        {:else}
          <div class="distribution-state distribution-state--error">ALLOCATION DATA UNAVAILABLE</div>
        {/if}
      </article>

      <article class="distribution-card distribution-card--chart">
        <div class="block-head distribution-card-head">
          <div class="block-title">
            <span class="card-index">05B</span>
            <span>DISTRIBUTION FLOW</span>
          </div>
          <div class="meta-strip"><span>[100% SYSTEM INCOME]</span></div>
        </div>

        {#if distributionLoading && !systemIncomeDistribution.complete}
          <div class="distribution-state">
            <div class="loader-bar"><span></span></div>
            <span>BUILDING FLOW</span>
          </div>
        {:else if distributionFlows.length}
          <div class="distribution-chart-shell">
            <canvas
              bind:this={distributionCanvas}
              aria-label="Flow chart of current THORChain system income distribution"
            ></canvas>
          </div>
          <p class="distribution-chart-foot">
            SYSTEM INCOME 100% → EXPLICIT ALLOCATIONS + BOND PROVIDER REMAINDER
          </p>
        {:else}
          <div class="distribution-state distribution-state--error">FLOW DATA UNAVAILABLE</div>
        {/if}
      </article>
    </div>
  </section>

  <section class="chart-block">
    <div class="block-head">
      <div class="block-title">
        <span class="block-marker">▌</span>
        <span>FEES PER $1B CMC + DUNE EXCHANGE VOLUME</span>
      </div>
      <div class="meta-strip">
        <span>[{granularity}]</span>
        <span>{summary.windowCount || rows.length} windows</span>
        {#if peak}
          <span>peak {formatUSD(peak.feesPerBillionUsd)}</span>
        {/if}
      </div>
    </div>

    {#if loading}
      <div class="state">
        <div class="loader-bar"><span></span></div>
        <span class="state-label">LOADING TC FEE SERIES</span>
      </div>
    {:else if error}
      <div class="state error-state">SERIES UNAVAILABLE</div>
    {:else if rows.length}
      <div class="chart-controls">
        <div class="control-group control-group--granularity">
          <span class="control-label">granularity</span>
          <div class="segmented-control" role="group" aria-label="Chart granularity">
            {#each GRANULARITIES as option}
              <button
                type="button"
                class:active={granularity === option.value}
                on:click={() => setGranularity(option.value)}
              >
                {option.label}
              </button>
            {/each}
          </div>
        </div>

        <div class="control-group control-group--rolling">
          <span class="control-label">rolling avg</span>
          <div class="toggle-row" role="group" aria-label="Rolling averages">
            {#each ROLLING_AVERAGES as option}
              <label
                class="rolling-toggle"
                class:active={rollingAverageState[option.days]}
                style="--ind-color: {option.color};"
              >
                <input
                  type="checkbox"
                  checked={rollingAverageState[option.days]}
                  aria-label={`${option.label} rolling average`}
                  on:change={() => toggleRollingAverage(option.days)}
                />
                <span class="tog-bracket tog-bracket--l">[</span>
                <span class="tog-mark">{rollingAverageState[option.days] ? '×' : ' '}</span>
                <span class="tog-bracket tog-bracket--r">]</span>
                <span class="tog-dash" aria-hidden="true"></span>
                <span class="tog-label">{option.label}</span>
              </label>
            {/each}
          </div>
        </div>

        <div class="control-group control-group--window">
          <div class="window-row">
            <span class="control-label">window</span>
            <span class="window-label">
              {formatDate(selectedStartRow?.windowStart)} — {formatDate(selectedEndRow?.windowStart)}
            </span>
            <span class="window-hint" aria-hidden="true">drag either chart · dbl-click resets</span>
            <button type="button" class="reset-button" on:click={resetWindow} disabled={isFullWindow}>all</button>
          </div>
        </div>
      </div>

      <div
        class="chart-shell"
        bind:this={chartShell}
        on:mousedown={(event) => chartBrushDown(event, 'fees')}
        on:dblclick={chartDblClick}
        role="presentation"
      >
        <canvas bind:this={chartCanvas} aria-label="TC fees per $1B CMC plus Dune exchange volume over time"></canvas>
        {#if brush.active && brush.chartType === 'fees'}
          {@const left = Math.min(brush.startX, brush.currentX)}
          {@const width = Math.abs(brush.currentX - brush.startX)}
          <div class="brush-overlay" style="left: {left}px; width: {width}px;" aria-hidden="true">
            <span class="brush-bracket brush-bracket--l">[</span>
            <span class="brush-bracket brush-bracket--r">]</span>
          </div>
        {/if}
      </div>

      <div class="navigator" aria-label="Time window navigator">
        <div class="nav-label">
          <span class="nav-label-tag">RANGE</span>
          <span class="nav-label-meta">{formatDate(rows[0]?.windowStart)} → {formatDate(rows.at(-1)?.windowStart)}</span>
        </div>
        <canvas
          bind:this={navCanvas}
          on:mousedown={navMouseDown}
          on:mousemove={navHoverCursor}
          on:dblclick={resetWindow}
          aria-label="Drag handles or window to adjust visible range"
        ></canvas>
      </div>

      <div class="secondary-chart">
        <div class="block-head secondary-chart-head">
          <div class="block-title">
            <span class="block-marker block-marker--amber">▌</span>
            <span>LIQUIDITY FEE INCOME / THORCHAIN VOLUME</span>
          </div>
          <div class="meta-strip">
            <span>[{granularity}]</span>
            {#if summary.weightedIncomeVolumeBps != null}
              <span>weighted {formatBps(summary.weightedIncomeVolumeBps)}</span>
            {/if}
            <span>{formatUsdCompact(summary.totalTcFeesUsd || 0)} income</span>
            {#if hasIncomeVolumeData}
              <span>{formatUsdCompact(summary.totalThorchainVolumeUsd || 0)} volume</span>
            {:else}
              <span>volume backfill pending</span>
            {/if}
          </div>
        </div>
        <p class="secondary-chart-note">
          Liquidity fee income divided by THORChain swap volume for the same selected window.
          Values are weighted by volume when grouped by week or month.
        </p>
        {#if hasIncomeVolumeData}
          <div
            class="income-volume-chart-shell"
            bind:this={incomeVolumeChartShell}
            on:mousedown={(event) => chartBrushDown(event, 'income-volume')}
            on:dblclick={chartDblClick}
            role="presentation"
          >
            <canvas
              bind:this={incomeVolumeCanvas}
              aria-label="THORChain liquidity fee income divided by THORChain volume over time"
            ></canvas>
            {#if brush.active && brush.chartType === 'income-volume'}
              {@const left = Math.min(brush.startX, brush.currentX)}
              {@const width = Math.abs(brush.currentX - brush.startX)}
              <div class="brush-overlay" style="left: {left}px; width: {width}px;" aria-hidden="true">
                <span class="brush-bracket brush-bracket--l">[</span>
                <span class="brush-bracket brush-bracket--r">]</span>
              </div>
            {/if}
          </div>
        {:else}
          <div class="income-volume-state">SYNCING MIDGARD VOLUME HISTORY</div>
        {/if}
      </div>

    {:else}
      <div class="state">NO TC FEE WINDOWS FOUND</div>
    {/if}
  </section>
</div>

<style>
  .tc-fee-dashboard {
    min-height: calc(100vh - 80px);
    background: #080808;
    color: var(--term-text-body, #d2d2d2);
    padding: 24px;
    font-family: 'DM Sans', -apple-system, sans-serif;
  }

  /* ========== HEAD ========== */

  .dash-head {
    margin-bottom: 22px;
  }

  .head-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--term-text-4, #949494);
    margin-bottom: 14px;
  }

  .head-left {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .prompt {
    color: #00cc66;
    font-weight: 700;
  }

  .cmd {
    color: var(--term-text-body, #d2d2d2);
    font-weight: 600;
  }

  .arg {
    color: var(--term-text-3, #a3a3a3);
  }

  .head-right {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--term-text-3, #a3a3a3);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #444444;
  }

  .dot.ok {
    background: #00cc66;
    box-shadow: 0 0 6px rgba(0, 204, 102, 0.4);
    animation: pulse-dot 2s infinite;
  }

  .dot.warn {
    background: #d4a017;
    box-shadow: 0 0 6px rgba(212, 160, 23, 0.4);
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }

  .sep {
    color: var(--term-text-7, #787878);
  }

  .refresh {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: 1px solid #1a1a1a;
    color: var(--term-text-3, #a3a3a3);
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 5px 10px;
    transition: border-color 0.15s ease, color 0.15s ease;
    text-transform: lowercase;
  }

  .refresh:hover:not(:disabled) {
    border-color: #00cc66;
    color: #00cc66;
  }

  .refresh:disabled {
    cursor: wait;
    opacity: 0.55;
  }

  .bracket {
    color: var(--term-text-7, #787878);
  }

  .key {
    color: #00cc66;
    font-weight: 700;
  }

  .title {
    margin: 0 0 10px;
    color: var(--term-text, #f5f5f5);
    font-family: 'JetBrains Mono', monospace;
    font-size: 30px;
    font-weight: 800;
    line-height: 1.1;
    letter-spacing: 0.06em;
  }

  .title .accent {
    color: #00cc66;
  }

  .cursor {
    color: #00cc66;
    animation: blink 1s steps(1) infinite;
    margin-left: 2px;
  }

  @keyframes blink {
    0%, 50% { opacity: 1; }
    50.01%, 100% { opacity: 0; }
  }

  .lede {
    margin: 0;
    color: var(--term-text-2, #b8b8b8);
    font-size: 13px;
    line-height: 1.5;
    max-width: 760px;
  }

  .rule {
    height: 1px;
    background: linear-gradient(90deg, #00cc66 0%, #1a1a1a 14%, #1a1a1a 100%);
    margin-top: 16px;
  }

  /* ========== ALERTS ========== */

  .alerts {
    margin-bottom: 16px;
  }

  /* ========== METRIC GRID ========== */

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1px;
    border: 1px solid #1a1a1a;
    background: #1a1a1a;
    margin-bottom: 18px;
  }

  .metric {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 116px;
    padding: 16px 18px;
    background: #0a0a0a;
    transition: background 0.15s ease;
  }

  .metric:hover {
    background: #0d0d0d;
  }

  .metric-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
  }

  .metric-idx {
    color: #00cc66;
    font-weight: 700;
  }

  .metric-label {
    color: var(--term-text-3, #a3a3a3);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-weight: 600;
  }

  .metric-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 24px;
    font-weight: 800;
    color: var(--term-text, #f5f5f5);
    letter-spacing: -0.01em;
    line-height: 1.1;
    margin-top: auto;
    overflow-wrap: anywhere;
  }

  .metric-value--amber {
    color: #d4a017;
  }

  .metric-foot {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--term-text-4, #949494);
  }

  /* ========== SYSTEM INCOME DISTRIBUTION ========== */

  .distribution-section {
    margin-bottom: 18px;
  }

  .distribution-section-head {
    align-items: center;
    display: flex;
    gap: 16px;
    justify-content: space-between;
    padding: 4px 2px 10px;
  }

  .distribution-grid {
    align-items: stretch;
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .distribution-card {
    background: #0a0a0a;
    border: 1px solid #1a1a1a;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .distribution-card-head {
    min-height: 52px;
    padding: 12px 14px;
  }

  .card-index {
    color: #00cc66;
    font-size: 11px;
    letter-spacing: 0.08em;
  }

  .distribution-note {
    color: var(--term-text-2, #b8b8b8);
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
    padding: 13px 16px;
  }

  .allocation-list {
    border-top: 1px solid #111111;
  }

  .allocation-row {
    display: grid;
    gap: 5px 12px;
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 10px 16px 11px;
    transition: background 0.15s ease;
  }

  .allocation-row + .allocation-row {
    border-top: 1px solid #111111;
  }

  .allocation-row:hover {
    background: #0d0d0d;
  }

  .allocation-main {
    align-items: center;
    display: flex;
    gap: 8px;
    min-width: 0;
  }

  .allocation-swatch {
    background: var(--allocation-color);
    flex: 0 0 auto;
    height: 8px;
    width: 8px;
  }

  .allocation-name,
  .allocation-source,
  .allocation-value,
  .allocation-key,
  .distribution-warning,
  .distribution-chart-foot,
  .distribution-state {
    font-family: 'JetBrains Mono', monospace;
  }

  .allocation-name {
    color: var(--term-text-body, #e8e8e8);
    font-size: 12px;
    font-weight: 700;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .allocation-source {
    color: var(--term-text-4, #949494);
    font-size: 10px;
    letter-spacing: 0.06em;
    white-space: nowrap;
  }

  .allocation-source--mimir {
    color: #00cc66;
  }

  .allocation-value {
    color: var(--allocation-color);
    font-size: 18px;
    line-height: 1;
  }

  .allocation-key {
    color: var(--term-text-4, #949494);
    font-size: 11px;
    grid-column: 1 / -1;
    overflow-wrap: anywhere;
  }

  .allocation-track {
    background: #111111;
    grid-column: 1 / -1;
    height: 2px;
    overflow: hidden;
  }

  .allocation-track span {
    background: var(--allocation-color);
    display: block;
    height: 100%;
    opacity: 0.82;
    width: var(--allocation-width);
  }

  .distribution-warning {
    border-top: 1px solid #1a1a1a;
    color: #d4a017;
    font-size: 11px;
    margin: 0;
    padding: 11px 16px;
  }

  .distribution-chart-shell {
    flex: 1;
    height: 440px;
    min-height: 390px;
    padding: 12px 10px 4px;
  }

  .distribution-chart-shell canvas {
    height: 100%;
    width: 100%;
  }

  .distribution-chart-foot {
    border-top: 1px solid #111111;
    color: var(--term-text-4, #949494);
    font-size: 11px;
    letter-spacing: 0.04em;
    margin: 0;
    padding: 10px 14px;
  }

  .distribution-state {
    align-items: center;
    color: var(--term-text-3, #a3a3a3);
    display: flex;
    flex: 1;
    flex-direction: column;
    font-size: 11px;
    gap: 14px;
    justify-content: center;
    letter-spacing: 0.08em;
    min-height: 390px;
  }

  .distribution-state--error {
    color: #e05260;
  }

  /* ========== CHART BLOCK ========== */

  .chart-block {
    background: #0a0a0a;
    border: 1px solid #1a1a1a;
    min-height: 560px;
  }

  .block-head {
    align-items: center;
    border-bottom: 1px solid #1a1a1a;
    display: flex;
    gap: 16px;
    justify-content: space-between;
    padding: 14px 16px;
  }

  .block-title,
  .meta-strip,
  .state {
    font-family: 'JetBrains Mono', monospace;
  }

  .block-title {
    align-items: center;
    color: #ffffff;
    display: flex;
    font-size: 12px;
    font-weight: 700;
    gap: 8px;
    letter-spacing: 0.08em;
  }

  .block-marker {
    color: #00cc66;
  }

  .block-marker--amber {
    color: #d4a017;
  }

  .meta-strip {
    color: var(--term-text-3, #a3a3a3);
    display: flex;
    flex-wrap: wrap;
    font-size: 11px;
    gap: 12px;
    justify-content: flex-end;
  }

  .meta-strip span:first-child {
    color: #00cc66;
  }

  .chart-controls {
    align-items: center;
    border-bottom: 1px solid #111111;
    display: grid;
    gap: 16px;
    grid-template-columns: minmax(180px, 220px) minmax(210px, 260px) 1fr;
    padding: 14px 16px;
  }

  .control-group {
    min-width: 0;
  }

  .control-group--granularity {
    align-items: center;
    display: flex;
    gap: 10px;
  }

  .control-group--rolling {
    align-items: center;
    display: grid;
    gap: 8px;
    grid-template-columns: auto 1fr;
  }

  .control-label,
  .window-label,
  .reset-button,
  .segmented-control button {
    font-family: 'JetBrains Mono', monospace;
  }

  .control-label {
    color: var(--term-text-3, #a3a3a3);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .segmented-control {
    border: 1px solid #1a1a1a;
    display: inline-grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    min-width: 138px;
  }

  .segmented-control button,
  .reset-button {
    background: transparent;
    border: 0;
    color: var(--term-text-3, #a3a3a3);
    cursor: pointer;
    font-size: 11px;
    min-height: 30px;
    padding: 0 10px;
    text-transform: lowercase;
  }

  .segmented-control button + button {
    border-left: 1px solid #1a1a1a;
  }

  .segmented-control button:hover,
  .reset-button:hover:not(:disabled),
  .segmented-control button.active {
    color: #00cc66;
  }

  .segmented-control button.active {
    background: rgba(0, 204, 102, 0.1);
  }

  .toggle-row {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
  }

  .rolling-toggle {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--term-text-4, #949494);
    cursor: pointer;
    display: inline-flex;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    gap: 6px;
    padding: 4px 2px;
    text-transform: lowercase;
    transition: color 0.12s ease;
  }

  .rolling-toggle input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
    width: 0;
    height: 0;
  }

  .tog-bracket {
    color: var(--term-text-7, #787878);
    font-weight: 700;
    transition: color 0.12s ease;
  }

  .tog-mark {
    color: #00cc66;
    font-weight: 700;
    min-width: 7px;
    text-align: center;
    line-height: 1;
  }

  .tog-dash {
    background: var(--ind-color, #00cc66);
    display: inline-block;
    height: 2px;
    opacity: 0.35;
    transition: opacity 0.12s ease;
    width: 16px;
  }

  .tog-label {
    color: inherit;
    letter-spacing: 0.04em;
  }

  .rolling-toggle:hover {
    color: var(--term-text-body, #d2d2d2);
  }

  .rolling-toggle:hover .tog-bracket {
    color: #00cc66;
  }

  .rolling-toggle:hover .tog-dash {
    opacity: 0.7;
  }

  .rolling-toggle.active {
    color: var(--term-text, #f5f5f5);
  }

  .rolling-toggle.active .tog-bracket {
    color: #00cc66;
  }

  .rolling-toggle.active .tog-dash {
    opacity: 1;
  }

  .rolling-toggle:focus-visible {
    outline: 1px solid #00cc66;
    outline-offset: 2px;
  }

  .control-group--window {
    align-items: center;
    display: flex;
  }

  .window-row {
    align-items: center;
    display: grid;
    gap: 10px;
    grid-template-columns: auto auto 1fr auto;
    width: 100%;
  }

  .window-label {
    color: var(--term-text-body, #e8e8e8);
    font-size: 11px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .window-hint {
    color: var(--term-text-4, #949494);
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: lowercase;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reset-button {
    border: 1px solid #1a1a1a;
  }

  .reset-button:disabled {
    cursor: default;
    opacity: 0.35;
  }

  .chart-shell {
    height: min(62vh, 620px);
    min-height: 420px;
    padding: 18px 18px 8px;
    position: relative;
    cursor: crosshair;
    user-select: none;
  }

  .chart-shell canvas {
    height: 100%;
    width: 100%;
  }

  .brush-overlay {
    position: absolute;
    top: 18px;
    bottom: 8px;
    background: rgba(0, 204, 102, 0.08);
    border-left: 1px solid #00cc66;
    border-right: 1px solid #00cc66;
    pointer-events: none;
    box-shadow: inset 0 0 0 1px rgba(0, 204, 102, 0.12);
  }

  .brush-bracket {
    color: #00cc66;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
    position: absolute;
    top: -4px;
  }

  .brush-bracket--l {
    left: -5px;
  }

  .brush-bracket--r {
    right: -5px;
  }

  .navigator {
    border-top: 1px solid #111111;
    padding: 10px 16px 12px;
    display: grid;
    gap: 6px;
  }

  .nav-label {
    align-items: baseline;
    display: flex;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    gap: 10px;
    justify-content: space-between;
  }

  .nav-label-tag {
    color: #00cc66;
    font-weight: 700;
    letter-spacing: 0.14em;
  }

  .nav-label-meta {
    color: var(--term-text-4, #949494);
    letter-spacing: 0.06em;
  }

  .navigator canvas {
    background: #050505;
    border: 1px solid #161616;
    display: block;
    height: 44px;
    width: 100%;
  }

  .secondary-chart {
    border-top: 1px solid #1a1a1a;
    margin-top: 18px;
  }

  .secondary-chart-head {
    border-bottom: 0;
  }

  .secondary-chart-note {
    color: var(--term-text-3, #a3a3a3);
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
    padding: 0 16px 4px;
  }

  .income-volume-chart-shell {
    height: min(48vh, 480px);
    min-height: 340px;
    padding: 14px 18px 18px;
    position: relative;
    cursor: crosshair;
    user-select: none;
  }

  .income-volume-chart-shell canvas {
    height: 100%;
    width: 100%;
  }

  .income-volume-chart-shell .brush-overlay {
    top: 14px;
    bottom: 18px;
  }

  .income-volume-state {
    align-items: center;
    color: #d4a017;
    display: flex;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    height: 220px;
    justify-content: center;
    letter-spacing: 0.08em;
  }

  .state {
    align-items: center;
    color: var(--term-text-3, #a3a3a3);
    display: flex;
    flex-direction: column;
    font-size: 12px;
    gap: 16px;
    height: 420px;
    justify-content: center;
    letter-spacing: 0.1em;
  }

  .state-label {
    color: var(--term-text-3, #a3a3a3);
  }

  .loader-bar {
    background: #111111;
    height: 4px;
    overflow: hidden;
    position: relative;
    width: 220px;
  }

  .loader-bar span {
    background: #00cc66;
    box-shadow: 0 0 8px rgba(0, 204, 102, 0.5);
    height: 100%;
    left: 0;
    position: absolute;
    top: 0;
    width: 40%;
    animation: loader-slide 1.2s steps(8) infinite;
  }

  @keyframes loader-slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(250%); }
  }

  .error-state {
    color: var(--term-error);
  }

  @media (max-width: 860px) {
    .metric-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .distribution-grid {
      grid-template-columns: 1fr;
    }

    .metric-value {
      font-size: clamp(20px, 5.2vw, 24px);
      overflow-wrap: normal;
      white-space: nowrap;
    }
  }

  @media (max-width: 720px) {
    .tc-fee-dashboard {
      padding: 14px;
    }

    .head-top,
    .block-head,
    .distribution-section-head,
    .chart-controls {
      align-items: stretch;
      flex-direction: column;
    }

    .head-top {
      gap: 10px;
    }

    .chart-controls {
      display: grid;
      grid-template-columns: 1fr;
    }

    .title {
      font-size: 24px;
    }

    .meta-strip {
      justify-content: flex-start;
    }

    .chart-shell {
      height: 440px;
      min-height: 360px;
      padding: 12px 8px 4px;
    }

    .income-volume-chart-shell {
      height: 380px;
      min-height: 320px;
      padding: 12px 8px 14px;
    }

    .distribution-chart-shell {
      height: 390px;
      min-height: 340px;
      padding: 8px 4px 2px;
    }
  }
</style>
