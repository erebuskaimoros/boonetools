<script>
  import { onDestroy, onMount } from 'svelte';
  import {
    isChartTrendVisible,
    toggleHiddenChartTrend
  } from './charts/terminal.js';
  import { fetchPoolDislocation, fetchPoolDislocationSeries } from './pool-dislocation/api.js';
  import {
    POOL_DISLOCATION_CHART_WINDOWS,
    DEFAULT_POOL_DISLOCATION_SOURCE_MODE,
    POOL_DISLOCATION_ROLLING_MIN_COVERAGE,
    POOL_DISLOCATION_ROLLING_WINDOWS,
    POOL_DISLOCATION_TABLE_COLUMNS,
    buildPoolDislocationLinePath,
    buildPoolDislocationRollingAverage,
    buildPoolDislocationChartScale,
    buildPoolDislocationChartViewport,
    buildPoolDislocationDashboard,
    DISLOCATION_WINDOWS,
    dislocationState,
    filterPoolDislocationDashboardByTrading,
    isPoolDislocationTickInsideMinimumBand,
    maxAbsoluteDislocation,
    normalizePoolDislocationSeries,
    normalizePoolDislocationSummary,
    projectPoolDislocationChartY,
    projectPoolDislocationChartSelection,
    resolvePoolDislocationSourceMode,
    sortPoolDislocationPools
  } from './pool-dislocation/model.js';

  const CHART = Object.freeze({ width: 1000, height: 520, left: 84, right: 24, top: 30, bottom: 456 });
  const Y_AXIS_LABEL_CLEARANCE = 18;
  const MIN_BAND_LABEL_SEPARATION = Y_AXIS_LABEL_CLEARANCE * 2;
  const MAX_CONTIGUOUS_GAP_MS = 7.5 * 60 * 1000;
  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  const thresholds = [0.5, 1, 2];
  const sourceModes = [
    { id: 'both', label: 'B', text: 'both' },
    { id: 'oracle', label: 'O', text: 'oracle' },
    { id: 'binance', label: 'X', text: 'binance' }
  ];
  const coverageModes = [
    { id: 'all', label: 'ALL' },
    { id: 'both', label: 'BOTH' },
    { id: 'partial', label: 'PARTIAL' },
    { id: 'tc', label: 'TC ONLY' }
  ];

  let summary = null;
  let selectedSeries = null;
  let selectedAsset = '';
  let threshold = 1;
  let preferredSourceMode = DEFAULT_POOL_DISLOCATION_SOURCE_MODE;
  let sourceMode = DEFAULT_POOL_DISLOCATION_SOURCE_MODE;
  let chartWindow = '7d';
  let selectedRollingAverageIds = [];
  let hiddenChartTrendIds = [];
  let chartZoom = null;
  let chartSelectionStartX = null;
  let chartSelectionCurrentX = null;
  let chartHoverPoint = null;
  let chartSvg;
  let coverageMode = 'all';
  let excludeHaltedChains = true;
  let search = '';
  let tableSort = { column: 'trend', direction: 'desc' };
  let loading = true;
  let refreshing = false;
  let seriesLoading = false;
  let summaryError = '';
  let seriesError = '';
  let refreshTimer;
  let visibilityHandler;
  let requestSequence = 0;
  let seriesController;

  $: dashboard = filterPoolDislocationDashboardByTrading(
    buildPoolDislocationDashboard(summary, threshold),
    excludeHaltedChains
  );
  $: selectedPool = dashboard.pools.find((pool) => pool.asset === selectedAsset) || dashboard.pools[0];
  $: availableSourceModes = sourceModes.filter((mode) => {
    const oracleAvailable = Boolean(selectedPool?.oracleSymbol);
    const binanceAvailable = Boolean(selectedPool?.binanceSymbol);
    if (mode.id === 'both') return oracleAvailable && binanceAvailable;
    return mode.id === 'oracle' ? oracleAvailable : binanceAvailable;
  });
  $: sourceMode = resolvePoolDislocationSourceMode(availableSourceModes, preferredSourceMode);
  $: selectedPoints = selectedSeries?.asset === selectedAsset ? selectedSeries.points : [];
  $: backfilledSamples = selectedSeries?.asset === selectedAsset
    ? selectedSeries?.provenance?.backfilledSamples || 0
    : 0;
  $: scheduledSamples = selectedSeries?.asset === selectedAsset
    ? selectedSeries?.provenance?.scheduledSamples || 0
    : 0;
  $: chartWindowConfig = POOL_DISLOCATION_CHART_WINDOWS.find((window) => window.id === chartWindow)
    || POOL_DISLOCATION_CHART_WINDOWS.at(-1);
  $: chartViewport = buildPoolDislocationChartViewport(selectedPoints, {
    endAt: summary?.as_of,
    durationMs: chartWindowConfig.durationMs,
    zoomStartMs: chartZoom?.startMs,
    zoomEndMs: chartZoom?.endMs
  });
  $: chartPoints = chartViewport.points;
  $: chartStartMs = chartViewport.startMs;
  $: chartEndMs = chartViewport.endMs;
  $: chartDurationMs = chartViewport.durationMs;
  $: chartRangeLabel = chartViewport.zoomed ? `${formatChartDuration(chartDurationMs)} ZOOM` : chartWindowConfig.label;
  $: oracleTrendVisible = isChartTrendVisible(hiddenChartTrendIds, 'oracle');
  $: binanceTrendVisible = isChartTrendVisible(hiddenChartTrendIds, 'binance');
  $: rollingAverageSeries = POOL_DISLOCATION_ROLLING_WINDOWS.map((window) => ({
    ...window,
    oraclePoints: buildPoolDislocationRollingAverage(selectedPoints, 'oracleDislocation', window),
    binancePoints: buildPoolDislocationRollingAverage(selectedPoints, 'binanceDislocation', window)
  }));
  $: activeRollingAverageSeries = rollingAverageSeries
    .filter((series) => (
      selectedRollingAverageIds.includes(series.id)
      && isChartTrendVisible(hiddenChartTrendIds, `average:${series.id}`)
    ))
    .map((series) => ({
      ...series,
      oraclePoints: series.oraclePoints.filter((point) => {
        const timestamp = Date.parse(point.observedAt);
        return timestamp >= chartStartMs && timestamp <= chartEndMs;
      }),
      binancePoints: series.binancePoints.filter((point) => {
        const timestamp = Date.parse(point.observedAt);
        return timestamp >= chartStartMs && timestamp <= chartEndMs;
      })
    }));
  $: rollingAverageScalePoints = activeRollingAverageSeries.flatMap((series) => [
    ...series.oraclePoints.map((point) => ({
      oracleDislocation: selectedPool?.oracleSymbol ? point.rollingAverage : null,
      binanceDislocation: null
    })),
    ...series.binancePoints.map((point) => ({
      oracleDislocation: null,
      binanceDislocation: selectedPool?.binanceSymbol ? point.rollingAverage : null
    }))
  ]);
  $: visibleChartPoints = chartPoints.map((point) => ({
    ...point,
    oracleDislocation: oracleTrendVisible ? point.oracleDislocation : null,
    binanceDislocation: binanceTrendVisible ? point.binanceDislocation : null
  }));
  $: chartScale = buildPoolDislocationChartScale(
    [...visibleChartPoints, ...rollingAverageScalePoints],
    { sourceMode, threshold, minimumBand: l1SlipMinPercent }
  );
  $: yMin = chartScale.min;
  $: yMax = chartScale.max;
  $: yTicks = chartScale.ticks;
  $: l1SlipMinBps = Number.isFinite(summary?.l1SlipMinBps) && summary.l1SlipMinBps > 0
    ? summary.l1SlipMinBps
    : null;
  $: l1SlipMinPercent = l1SlipMinBps === null ? 0 : l1SlipMinBps / 100;
  $: l1SlipMinBandVisible = l1SlipMinPercent > 0
    && l1SlipMinPercent <= yMax
    && -l1SlipMinPercent >= yMin;
  $: l1SlipMinPositiveY = l1SlipMinBandVisible
    ? chartY(l1SlipMinPercent, yMin, yMax)
    : null;
  $: l1SlipMinNegativeY = l1SlipMinBandVisible
    ? chartY(-l1SlipMinPercent, yMin, yMax)
    : null;
  $: l1SlipMinLabelsCollapsed = l1SlipMinBandVisible
    && Math.abs(l1SlipMinNegativeY - l1SlipMinPositiveY) < MIN_BAND_LABEL_SEPARATION;
  $: l1SlipMinAxisLabelY = l1SlipMinLabelsCollapsed
    ? (l1SlipMinPositiveY + l1SlipMinNegativeY) / 2
    : null;
  $: oraclePath = makeLinePath(chartPoints, 'oracleDislocation', yMin, yMax);
  $: binancePath = makeLinePath(chartPoints, 'binanceDislocation', yMin, yMax);
  $: rollingAveragePaths = activeRollingAverageSeries.map((series) => ({
    ...series,
    oraclePath: makeLinePath(series.oraclePoints, 'rollingAverage', yMin, yMax),
    binancePath: makeLinePath(series.binancePoints, 'rollingAverage', yMin, yMax)
  }));
  $: hoverPoint = chartPoints.find((point) => point.observedAt === chartHoverPoint?.observedAt) || null;
  $: hoverRollingAverages = activeRollingAverageSeries.map((series) => {
    const oraclePoint = series.oraclePoints.find((point) => point.observedAt === hoverPoint?.observedAt) || null;
    const binancePoint = series.binancePoints.find((point) => point.observedAt === hoverPoint?.observedAt) || null;
    return {
      ...series,
      oraclePoint,
      binancePoint,
      oracleAverage: oraclePoint?.rollingAverage ?? null,
      binanceAverage: binancePoint?.rollingAverage ?? null
    };
  });
  $: xTicks = Array.from({ length: 5 }, (_, index) => ({
    observedAt: new Date(chartStartMs + ((index / 4) * chartDurationMs)).toISOString(),
    index
  }));
  $: pointMarkerStep = Math.max(1, Math.floor(chartPoints.length / 8));
  $: filteredPools = sortPoolDislocationPools(
    dashboard.pools.filter((pool) => {
      const query = search.trim().toUpperCase();
      const matchesSearch = !query || `${pool.asset} ${pool.symbol} ${pool.chain}`.includes(query);
      const coverage = coverageState(pool);
      return matchesSearch && (coverageMode === 'all' || coverageMode === coverage);
    }),
    { ...tableSort, threshold }
  );
  $: liveState = summary?.stale ? 'STALE' : summaryError || (summary?.warnings || []).length ? 'DEGRADED' : loading ? 'SYNCING' : 'LIVE';

  onMount(() => {
    loadSummary({ forceRefresh: true });
    refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadSummary({ forceRefresh: true, silent: true });
    }, REFRESH_INTERVAL_MS);
    visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      const age = Date.now() - Date.parse(summary?.as_of || '');
      if (!Number.isFinite(age) || age >= REFRESH_INTERVAL_MS) {
        loadSummary({ forceRefresh: true, silent: true });
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
    window.addEventListener('focus', visibilityHandler);
  });

  onDestroy(() => {
    clearInterval(refreshTimer);
    seriesController?.abort();
    document.removeEventListener('visibilitychange', visibilityHandler);
    window.removeEventListener('focus', visibilityHandler);
  });

  async function loadSummary(options = {}) {
    if (refreshing) return;
    refreshing = true;
    if (!options.silent) loading = !summary;
    summaryError = '';
    try {
      const payload = await fetchPoolDislocation({ forceRefresh: options.forceRefresh });
      const nextSummary = normalizePoolDislocationSummary(payload);
      summary = nextSummary;
      const nextDashboard = filterPoolDislocationDashboardByTrading(
        buildPoolDislocationDashboard(nextSummary, threshold),
        excludeHaltedChains
      );
      const nextAsset = nextDashboard.pools.some((pool) => pool.asset === selectedAsset)
        ? selectedAsset
        : nextDashboard.currentLeader?.asset || nextDashboard.pools[0]?.asset || '';
      if (nextAsset) await selectPool(nextAsset, { forceRefresh: options.forceRefresh });
    } catch (error) {
      summaryError = error?.message || 'Pool dislocation history is unavailable.';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function selectPool(asset, options = {}) {
    const nextAsset = String(asset || '');
    if (!nextAsset) return;
    if (nextAsset !== selectedAsset) resetChartZoom();
    selectedAsset = nextAsset;
    seriesError = '';
    seriesLoading = true;
    const sequence = ++requestSequence;
    seriesController?.abort();
    seriesController = new AbortController();
    try {
      const payload = await fetchPoolDislocationSeries(nextAsset, {
        forceRefresh: options.forceRefresh,
        signal: seriesController.signal
      });
      if (sequence === requestSequence) selectedSeries = normalizePoolDislocationSeries(payload);
    } catch (error) {
      if (error?.name !== 'AbortError' && sequence === requestSequence) {
        selectedSeries = null;
        seriesError = error?.message || 'Exact five-minute series is unavailable.';
      }
    } finally {
      if (sequence === requestSequence) seriesLoading = false;
    }
  }

  function chartX(point) {
    const plotWidth = CHART.width - CHART.left - CHART.right;
    const timestamp = Date.parse(point?.observedAt || point || '');
    const ratio = Number.isFinite(timestamp)
      ? Math.min(1, Math.max(0, (timestamp - chartStartMs) / chartDurationMs))
      : 0;
    return CHART.left + (ratio * plotWidth);
  }

  function chartY(value, min = yMin, max = yMax) {
    return projectPoolDislocationChartY(value, {
      min,
      max,
      top: CHART.top,
      bottom: CHART.bottom
    });
  }

  function showYAxisTickLabel(tick) {
    if (!l1SlipMinBandVisible) return true;
    if (isPoolDislocationTickInsideMinimumBand(tick, l1SlipMinPercent)) return false;
    const tickY = chartY(tick);
    const labelYs = l1SlipMinLabelsCollapsed
      ? [l1SlipMinAxisLabelY]
      : [l1SlipMinPositiveY, l1SlipMinNegativeY];
    return labelYs.every((labelY) => Math.abs(tickY - labelY) >= Y_AXIS_LABEL_CLEARANCE);
  }

  function makeLinePath(points, field, min, max) {
    return buildPoolDislocationLinePath(points, field, {
      projectX: chartX,
      projectY: (value) => chartY(value, min, max),
      maximumGapMs: MAX_CONTIGUOUS_GAP_MS
    });
  }

  function toggleRollingAverage(id) {
    selectedRollingAverageIds = selectedRollingAverageIds.includes(id)
      ? selectedRollingAverageIds.filter((selectedId) => selectedId !== id)
      : [...selectedRollingAverageIds, id];
    hiddenChartTrendIds = hiddenChartTrendIds.filter((trendId) => trendId !== `average:${id}`);
  }

  function toggleChartTrend(trendId) {
    hiddenChartTrendIds = toggleHiddenChartTrend(hiddenChartTrendIds, trendId);
  }

  function formatBasisPoints(value, { signed = true } = {}) {
    if (value === null || value === undefined || value === '') return '—';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '—';
    const basisPoints = numeric * 100;
    const absolute = Math.abs(basisPoints);
    const maximumFractionDigits = absolute >= 100 ? 0 : absolute >= 10 ? 1 : 2;
    const sign = signed && basisPoints > 0 ? '+' : '';
    return `${sign}${new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(basisPoints)} BPS`;
  }

  function formatRollingCoverage(point) {
    const observedSamples = Number(point?.observedSamples);
    const expectedSamples = Number(point?.expectedSamples);
    const coverage = Number(point?.coverage);
    if (!Number.isFinite(observedSamples) || !Number.isFinite(expectedSamples) || !Number.isFinite(coverage)) return '—';
    const percent = coverage >= 0.9995 ? '100' : (coverage * 100).toFixed(1);
    return `${percent}% · ${observedSamples}/${expectedSamples}`;
  }

  function formatPrice(value) {
    if (value === null || value === undefined || value === '') return '—';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '—';
    const maximumFractionDigits = numeric >= 1000 ? 0 : numeric >= 10 ? 2 : numeric >= 1 ? 3 : 5;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits
    }).format(numeric);
  }

  function formatAxisBasisPoints(value) {
    return formatBasisPoints(value);
  }

  function formatChartTick(observedAt, index) {
    if (index === 4) return 'NOW';
    const date = new Date(observedAt);
    const day = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC'
    }).format(date).toUpperCase();
    if (chartDurationMs > 2 * 24 * 60 * 60 * 1000) return day;
    const time = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC'
    }).format(date).toUpperCase();
    return chartDurationMs <= 6 * 60 * 60 * 1000 ? time : `${day} ${time}`;
  }

  function formatChartDuration(durationMs) {
    const minutes = Math.max(5, Math.round(Number(durationMs || 0) / 60000));
    if (minutes < 60) return `${minutes}M`;
    const hours = minutes / 60;
    if (hours < 24) return `${hours < 10 && !Number.isInteger(hours) ? hours.toFixed(1) : Math.round(hours)}H`;
    const days = hours / 24;
    return `${days < 10 && !Number.isInteger(days) ? days.toFixed(1) : Math.round(days)}D`;
  }

  function selectChartWindow(windowId) {
    chartWindow = windowId;
    resetChartZoom();
  }

  function resetChartZoom() {
    chartZoom = null;
    chartSelectionStartX = null;
    chartSelectionCurrentX = null;
    chartHoverPoint = null;
  }

  function chartPointerX(event) {
    const bounds = chartSvg?.getBoundingClientRect();
    if (!bounds?.width) return null;
    return Math.min(
      CHART.width - CHART.right,
      Math.max(CHART.left, ((event.clientX - bounds.left) / bounds.width) * CHART.width)
    );
  }

  function startChartSelection(event) {
    if (event.button !== 0) return;
    const pointerX = chartPointerX(event);
    if (!Number.isFinite(pointerX)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    chartSelectionStartX = pointerX;
    chartSelectionCurrentX = pointerX;
    chartHoverPoint = null;
  }

  function updateChartInteraction(event) {
    const pointerX = chartPointerX(event);
    if (!Number.isFinite(pointerX)) return;
    if (Number.isFinite(chartSelectionStartX)) {
      chartSelectionCurrentX = pointerX;
      return;
    }
    const pointerTime = chartStartMs
      + (((pointerX - CHART.left) / (CHART.width - CHART.left - CHART.right)) * chartDurationMs);
    chartHoverPoint = chartPoints.reduce((nearest, point) => {
      if (!nearest) return point;
      return Math.abs(Date.parse(point.observedAt) - pointerTime)
        < Math.abs(Date.parse(nearest.observedAt) - pointerTime) ? point : nearest;
    }, null);
  }

  function finishChartSelection(event) {
    if (!Number.isFinite(chartSelectionStartX)) return;
    const pointerX = chartPointerX(event);
    if (Number.isFinite(pointerX)) chartSelectionCurrentX = pointerX;
    const nextZoom = projectPoolDislocationChartSelection({
      plotLeft: CHART.left,
      plotRight: CHART.width - CHART.right,
      startX: chartSelectionStartX,
      endX: chartSelectionCurrentX,
      viewportStartMs: chartStartMs,
      viewportEndMs: chartEndMs
    });
    chartSelectionStartX = null;
    chartSelectionCurrentX = null;
    chartHoverPoint = null;
    if (nextZoom) chartZoom = nextZoom;
  }

  function cancelChartSelection() {
    chartSelectionStartX = null;
    chartSelectionCurrentX = null;
    chartHoverPoint = null;
  }

  function clearChartHover() {
    if (!Number.isFinite(chartSelectionStartX)) chartHoverPoint = null;
  }

  function selectTableSort(columnId) {
    const column = POOL_DISLOCATION_TABLE_COLUMNS.find(({ id }) => id === columnId);
    if (!column) return;
    tableSort = tableSort.column === columnId
      ? { column: columnId, direction: tableSort.direction === 'asc' ? 'desc' : 'asc' }
      : { column: columnId, direction: column.defaultDirection };
  }

  function tableSortAria(columnId) {
    if (tableSort.column !== columnId) return 'none';
    return tableSort.direction === 'asc' ? 'ascending' : 'descending';
  }

  function tableSortIndicator(columnId) {
    if (tableSort.column !== columnId) return '↕';
    return tableSort.direction === 'asc' ? '↑' : '↓';
  }

  function formatHours(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '0H';
    if (numeric < 1) return `${Math.round(numeric * 60)}M`;
    if (numeric < 10) return `${numeric.toFixed(1)}H`;
    return `${Math.round(numeric)}H`;
  }

  function formatTimestamp(value) {
    const date = new Date(value || '');
    if (!Number.isFinite(date.getTime())) return '—';
    return date.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
    }).toUpperCase();
  }

  function coverageState(pool) {
    if (pool?.oracleSymbol && pool?.binanceSymbol) return 'both';
    if (pool?.oracleSymbol || pool?.binanceSymbol) return 'partial';
    return 'tc';
  }

  function toggleHaltedChains() {
    excludeHaltedChains = !excludeHaltedChains;
    const nextDashboard = filterPoolDislocationDashboardByTrading(
      buildPoolDislocationDashboard(summary, threshold),
      excludeHaltedChains
    );
    if (!nextDashboard.pools.some((pool) => pool.asset === selectedAsset)) {
      const nextAsset = nextDashboard.currentLeader?.asset || nextDashboard.pools[0]?.asset;
      if (nextAsset) selectPool(nextAsset);
    }
  }

  function sparkPath(pool) {
    const values = (pool?.sparkline || []).map(maxAbsoluteDislocation).filter((value) => value !== null);
    if (values.length === 0) return '';
    const width = 92;
    const height = 26;
    const max = Math.max(0.5, ...values);
    return values.map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * width;
      const y = height - ((value / max) * (height - 3)) - 1.5;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(' ');
  }
</script>

<svelte:head>
  <meta name="description" content="Track THORChain pool price dislocation against oracle and Binance references at exact five-minute intervals." />
</svelte:head>

<div class="dashboard-shell">
  <header class="command-head">
    <div class="command"><span>$</span> monitor pool-dislocation <em>--history 7d --chart {chartRangeLabel.toLowerCase()} --refs oracle,binance</em></div>
    <div class:degraded={liveState !== 'LIVE'} class="command-state"><span class="preview-dot"></span> {liveState}</div>
  </header>

  <div class="title-row">
    <div>
      <h1><span>&gt;</span> POOL DISLOCATION<span class="cursor">_</span></h1>
      <p>Track where THORChain pool prices separate from network oracle and Binance spot references.</p>
    </div>
    <div class="window-stamp"><span>HISTORY</span><strong>7D / EXACT 5M</strong></div>
  </div>

  <section class="metric-grid" aria-label="Pool dislocation overview">
    <div class="metric-cell">
      <span class="metric-index">01</span>
      <span class="metric-label">REFERENCE COVERAGE</span>
      <strong>{dashboard.coveredPools}/{dashboard.totalPools}</strong>
      <small>{dashboard.mappedPools} mapped · latest aligned</small>
    </div>
    <div class="metric-cell">
      <span class="metric-index">02</span>
      <span class="metric-label">MOST DISLOCATED NOW</span>
      <strong class={dislocationState(dashboard.currentLeader?.currentAbsolute, threshold)}>{formatBasisPoints(dashboard.currentLeader?.currentAbsolute, { signed: false })}</strong>
      <small>{dashboard.currentLeader?.symbol || '—'} · max reference gap</small>
    </div>
    <div class="metric-cell">
      <span class="metric-index">03</span>
      <span class="metric-label">7D PEAK</span>
      <strong class={dislocationState(dashboard.peakLeader?.peakAbsolute, threshold)}>{formatBasisPoints(dashboard.peakLeader?.peakAbsolute, { signed: false })}</strong>
      <small>{dashboard.peakLeader?.symbol || '—'} · absolute deviation</small>
    </div>
    <div class="metric-cell">
      <span class="metric-index">04</span>
      <span class="metric-label">OUTSIDE THRESHOLD</span>
      <strong>{dashboard.outsideThreshold}</strong>
      <small>pools ≥ {formatBasisPoints(threshold, { signed: false })} now</small>
    </div>
  </section>

  {#if loading}
    <div class="preview-alert syncing" role="status"><span>SYNC</span> Loading the durable pool-dislocation read model.</div>
  {:else if summaryError}
    <div class="preview-alert error" role="alert"><span>ERR</span> {summaryError}</div>
  {:else if summary?.stale || (summary?.warnings || []).length}
    <div class="preview-alert" role="note"><span>WRN</span> {[...(summary?.warnings || []), ...(summary?.stale ? ['Snapshot is stale.'] : [])].join(' ')}</div>
  {:else}
    <div class="source-line" role="status">
      <span>AS OF {formatTimestamp(summary?.as_of)} UTC</span>
      <span>TC {summary?.sources?.pool?.status || '—'}</span>
      <span>ORACLE {summary?.sources?.oracle?.status || '—'}</span>
      <span>BINANCE {summary?.sources?.binance?.status || '—'}</span>
      <span>TRADING {summary?.sources?.trading?.status || '—'}</span>
    </div>
  {/if}

  {#if backfilledSamples > 0}
    <div class="preview-alert info" role="note">
      <span>INF</span>
      {backfilledSamples} HISTORICAL POINTS USE SAME-BLOCK THORNODE POOL + ORACLE STATE AND BINANCE 5M CLOSE; {scheduledSamples} LIVE POINTS USE BINANCE BBO MID.
    </div>
  {/if}

  <section class="block focus-block" aria-labelledby="focus-title">
    <div class="block-head">
      <div class="block-title"><span>▌</span><h2 id="focus-title">{selectedPool?.symbol || 'POOL'} DISLOCATION / {chartRangeLabel}</h2></div>
      <div class="focus-controls">
        <div class="control-row">
          <span class="control-label">WINDOW</span>
          {#each POOL_DISLOCATION_CHART_WINDOWS as window}
            <button
              class:active={!chartViewport.zoomed && chartWindow === window.id}
              aria-pressed={!chartViewport.zoomed && chartWindow === window.id}
              on:click={() => selectChartWindow(window.id)}
            ><i>[{window.label}]</i></button>
          {/each}
          {#if chartViewport.zoomed}
            <button class="zoom-reset active" on:click={resetChartZoom}><i>[RESET ZOOM]</i></button>
          {/if}
        </div>
        <div class="control-row">
          <span class="control-label">REF</span>
          {#if availableSourceModes.length}
            {#each availableSourceModes as mode}
              <button
                class:active={sourceMode === mode.id}
                aria-pressed={sourceMode === mode.id}
                on:click={() => preferredSourceMode = mode.id}
              ><i>[{mode.label}]</i> {mode.text}</button>
            {/each}
          {:else}
            <span class="source-unavailable">[—] NO EXTERNAL REFERENCE</span>
          {/if}
        </div>
        <div class="control-row">
          <span class="control-label">AVG</span>
          {#each POOL_DISLOCATION_ROLLING_WINDOWS as window}
            <button
              class:active={selectedRollingAverageIds.includes(window.id)}
              aria-pressed={selectedRollingAverageIds.includes(window.id)}
              title={`Toggle ${window.label} signed trailing average (minimum ${Math.round(POOL_DISLOCATION_ROLLING_MIN_COVERAGE * 100)}% exact-point coverage)`}
              on:click={() => toggleRollingAverage(window.id)}
            ><i>[{window.label}]</i></button>
          {/each}
        </div>
      </div>
    </div>

    <div class="focus-grid">
      <div class="chart-wrap">
        <div class="chart-legend">
          <span class="zoom-hint">{chartViewport.zoomed ? 'ZOOM ACTIVE · DRAG AGAIN OR RESET' : 'DRAG TO HIGHLIGHT + ZOOM'}</span>
          {#if selectedPool?.oracleSymbol && sourceMode !== 'binance'}
            <button
              type="button"
              class="trend-key oracle-key"
              class:is-hidden={!oracleTrendVisible}
              aria-pressed={oracleTrendVisible}
              aria-label={`${oracleTrendVisible ? 'Hide' : 'Show'} TC / Oracle trends`}
              title={`${oracleTrendVisible ? 'Hide' : 'Show'} TC / Oracle trends`}
              on:click={() => toggleChartTrend('oracle')}
            ><i aria-hidden="true"></i>TC / ORACLE</button>
          {/if}
          {#if selectedPool?.binanceSymbol && sourceMode !== 'oracle'}
            <button
              type="button"
              class="trend-key binance-key"
              class:is-hidden={!binanceTrendVisible}
              aria-pressed={binanceTrendVisible}
              aria-label={`${binanceTrendVisible ? 'Hide' : 'Show'} TC / Binance trends`}
              title={`${binanceTrendVisible ? 'Hide' : 'Show'} TC / Binance trends`}
              on:click={() => toggleChartTrend('binance')}
            ><i aria-hidden="true"></i>TC / BINANCE</button>
          {/if}
          {#each POOL_DISLOCATION_ROLLING_WINDOWS.filter((window) => selectedRollingAverageIds.includes(window.id)) as window}
            {@const averageTrendVisible = isChartTrendVisible(hiddenChartTrendIds, `average:${window.id}`)}
            <button
              type="button"
              class={`trend-key average-key avg-${window.id}`}
              class:is-hidden={!averageTrendVisible}
              aria-pressed={averageTrendVisible}
              aria-label={`${averageTrendVisible ? 'Hide' : 'Show'} ${window.label} signed average trends`}
              title={`${averageTrendVisible ? 'Hide' : 'Show'} ${window.label} signed average trends`}
              on:click={() => toggleChartTrend(`average:${window.id}`)}
            ><i aria-hidden="true"></i>{window.label} SIGNED AVG · ≥{Math.round(POOL_DISLOCATION_ROLLING_MIN_COVERAGE * 100)}%</button>
          {/each}
          {#if l1SlipMinBandVisible}<span class="minbps-key"><i></i>±{formatBasisPoints(l1SlipMinPercent, { signed: false })} L1 MIN</span>{/if}
        </div>
        <svg
          bind:this={chartSvg}
          viewBox={`0 0 ${CHART.width} ${CHART.height}`}
          role="img"
          aria-label={`${selectedPool?.symbol} ${chartRangeLabel} pool price deviation chart${l1SlipMinBandVisible ? ` with current L1 minimum corridor at plus or minus ${l1SlipMinBps} basis points` : ''}. Drag horizontally to zoom; double click to reset.`}
        >
          {#if l1SlipMinBandVisible}
            <rect
              class="minbps-zone"
              x={CHART.left}
              y={l1SlipMinPositiveY}
              width={CHART.width - CHART.left - CHART.right}
              height={Math.max(0, l1SlipMinNegativeY - l1SlipMinPositiveY)}
            />
          {/if}
          {#each yTicks as tick}
            <line class:zero={tick === 0} class="grid-line" x1={CHART.left} x2={CHART.width - CHART.right} y1={chartY(tick)} y2={chartY(tick)} />
            {#if showYAxisTickLabel(tick)}
              <text class="axis-label y" x={CHART.left - 12} y={chartY(tick) + 4}>{formatAxisBasisPoints(tick)}</text>
            {/if}
          {/each}
          {#if l1SlipMinBandVisible}
            <line class="minbps-line" x1={CHART.left} x2={CHART.width - CHART.right} y1={l1SlipMinPositiveY} y2={l1SlipMinPositiveY} />
            <line class="minbps-line" x1={CHART.left} x2={CHART.width - CHART.right} y1={l1SlipMinNegativeY} y2={l1SlipMinNegativeY} />
            {#if l1SlipMinLabelsCollapsed}
              <text class="minbps-axis-label" x={CHART.left - 12} y={l1SlipMinAxisLabelY + 4}>±{formatBasisPoints(l1SlipMinPercent, { signed: false })} MIN</text>
            {:else}
              <text class="minbps-axis-label" x={CHART.left - 12} y={l1SlipMinPositiveY + 4}>{formatBasisPoints(l1SlipMinPercent)} MIN</text>
              <text class="minbps-axis-label" x={CHART.left - 12} y={l1SlipMinNegativeY + 4}>{formatBasisPoints(-l1SlipMinPercent)} MIN</text>
            {/if}
          {/if}
          {#each xTicks as tick}
            <line class="x-tick" x1={chartX(tick.observedAt)} x2={chartX(tick.observedAt)} y1={CHART.bottom} y2={CHART.bottom + 5} />
            <text class="axis-label x" x={chartX(tick.observedAt)} y={CHART.bottom + 24}>{formatChartTick(tick.observedAt, tick.index)}</text>
          {/each}
          {#if selectedPool?.oracleSymbol && sourceMode !== 'binance' && oracleTrendVisible && oraclePath}<path class="series oracle" d={oraclePath} />{/if}
          {#if selectedPool?.binanceSymbol && sourceMode !== 'oracle' && binanceTrendVisible && binancePath}<path class="series binance" d={binancePath} />{/if}
          {#each rollingAveragePaths as series}
            {#if selectedPool?.oracleSymbol && sourceMode !== 'binance' && series.oraclePath}
              <path class={`series rolling-average oracle avg-${series.id}`} d={series.oraclePath} />
            {/if}
            {#if selectedPool?.binanceSymbol && sourceMode !== 'oracle' && series.binancePath}
              <path class={`series rolling-average binance avg-${series.id}`} d={series.binancePath} />
            {/if}
          {/each}
          {#each chartPoints as point, index}
            {#if index % pointMarkerStep === 0 || index === chartPoints.length - 1}
              {#if sourceMode !== 'binance' && oracleTrendVisible && Number.isFinite(point.oracleDislocation)}<circle class="point oracle" cx={chartX(point)} cy={chartY(point.oracleDislocation)} r={index === chartPoints.length - 1 ? 4 : 2.25} />{/if}
              {#if sourceMode !== 'oracle' && binanceTrendVisible && Number.isFinite(point.binanceDislocation)}<circle class="point binance" cx={chartX(point)} cy={chartY(point.binanceDislocation)} r={index === chartPoints.length - 1 ? 4 : 2.25} />{/if}
            {/if}
          {/each}
          {#if hoverPoint && !Number.isFinite(chartSelectionStartX)}
            <line class="hover-crosshair" x1={chartX(hoverPoint)} x2={chartX(hoverPoint)} y1={CHART.top} y2={CHART.bottom} />
            {#if sourceMode !== 'binance' && oracleTrendVisible && Number.isFinite(hoverPoint.oracleDislocation)}
              <circle class="hover-point oracle" cx={chartX(hoverPoint)} cy={chartY(hoverPoint.oracleDislocation)} r="5" />
            {/if}
            {#if sourceMode !== 'oracle' && binanceTrendVisible && Number.isFinite(hoverPoint.binanceDislocation)}
              <circle class="hover-point binance" cx={chartX(hoverPoint)} cy={chartY(hoverPoint.binanceDislocation)} r="5" />
            {/if}
          {/if}
          {#if Number.isFinite(chartSelectionStartX) && Number.isFinite(chartSelectionCurrentX)}
            <rect
              class="zoom-selection"
              x={Math.min(chartSelectionStartX, chartSelectionCurrentX)}
              y={CHART.top}
              width={Math.abs(chartSelectionCurrentX - chartSelectionStartX)}
              height={CHART.bottom - CHART.top}
            />
          {/if}
          <rect
            class="chart-hitbox"
            role="presentation"
            x={CHART.left}
            y={CHART.top}
            width={CHART.width - CHART.left - CHART.right}
            height={CHART.bottom - CHART.top}
            on:pointerdown={startChartSelection}
            on:pointermove={updateChartInteraction}
            on:pointerup={finishChartSelection}
            on:pointercancel={cancelChartSelection}
            on:pointerleave={clearChartHover}
            on:dblclick={resetChartZoom}
          />
        </svg>
        {#if hoverPoint && !Number.isFinite(chartSelectionStartX)}
          <div
            class:right={chartX(hoverPoint) > CHART.width * 0.64}
            class="chart-tooltip"
            role="tooltip"
            style={`left: ${((chartX(hoverPoint) / CHART.width) * 100).toFixed(2)}%`}
          >
            <strong>{formatTimestamp(hoverPoint.observedAt)} UTC</strong>
            <div><span>TC POOL</span><b>{formatPrice(hoverPoint.poolPrice)}</b></div>
            {#if sourceMode !== 'binance' && oracleTrendVisible}
              <div><span>TC ORACLE</span><b>{formatPrice(hoverPoint.oraclePrice)}</b></div>
              <div><span>VS ORACLE</span><b class={dislocationState(hoverPoint.oracleDislocation, threshold)}>{formatBasisPoints(hoverPoint.oracleDislocation)}</b></div>
            {/if}
            {#if sourceMode !== 'oracle' && binanceTrendVisible}
              <div><span>BINANCE</span><b>{formatPrice(hoverPoint.binancePrice)}</b></div>
              <div><span>VS BINANCE</span><b class={dislocationState(hoverPoint.binanceDislocation, threshold)}>{formatBasisPoints(hoverPoint.binanceDislocation)}</b></div>
            {/if}
            {#each hoverRollingAverages as average}
              {#if selectedPool?.oracleSymbol && sourceMode !== 'binance'}
                <div>
                  <span>{average.label} ORACLE AVG <small class:partial={average.oraclePoint?.coverage < 1}>{formatRollingCoverage(average.oraclePoint)}</small></span>
                  <b>{formatBasisPoints(average.oracleAverage)}</b>
                </div>
              {/if}
              {#if selectedPool?.binanceSymbol && sourceMode !== 'oracle'}
                <div>
                  <span>{average.label} BINANCE AVG <small class:partial={average.binancePoint?.coverage < 1}>{formatRollingCoverage(average.binancePoint)}</small></span>
                  <b>{formatBasisPoints(average.binanceAverage)}</b>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
        {#if seriesLoading}
          <div class="chart-status">SYNCING EXACT FIVE-MINUTE POINTS…</div>
        {:else if seriesError}
          <div class="chart-status error">{seriesError}</div>
        {:else if chartPoints.length === 0}
          <div class="chart-status">NO OBSERVATIONS IN THE SELECTED CHART RANGE</div>
        {/if}
      </div>

      <aside class="reading-panel" aria-label={`${selectedPool?.symbol} latest reading`}>
        <div class="reading-head"><span>VISIBLE 5M POINTS</span><strong>{chartPoints.length}/{chartViewport.expectedSamples}</strong></div>
        <div class="price-stack">
          <div><span>TC POOL</span><strong>{formatPrice(selectedPool?.current?.poolPrice)}</strong></div>
          <div><span>TC ORACLE</span><strong>{formatPrice(selectedPool?.current?.oraclePrice)}</strong></div>
          <div><span>BINANCE</span><strong>{formatPrice(selectedPool?.current?.binancePrice)}</strong></div>
        </div>
        <div class="delta-stack">
          <div>
            <span>VS ORACLE</span>
            <strong class={dislocationState(selectedPool?.current?.oracleDislocation, threshold)}>{formatBasisPoints(selectedPool?.current?.oracleDislocation)}</strong>
          </div>
          <div>
            <span>VS BINANCE</span>
            <strong class={dislocationState(selectedPool?.current?.binanceDislocation, threshold)}>{formatBasisPoints(selectedPool?.current?.binanceDislocation)}</strong>
          </div>
        </div>
        <div class="reading-foot">
          {#each DISLOCATION_WINDOWS as window}
            <div><span>{window.label} AVG ABS</span><strong>{formatBasisPoints(selectedPool?.averageAbsoluteByWindow?.[window.id], { signed: false })}</strong></div>
          {/each}
          <div><span>7D PEAK ABS</span><strong>{formatBasisPoints(selectedPool?.peakAbsolute, { signed: false })}</strong></div>
          <div><span>TIME OUTSIDE</span><strong>{formatHours(selectedPool?.hoursOutsideThreshold)}</strong></div>
          <div><span>OBSERVED</span><strong>{formatTimestamp(selectedPool?.current?.observedAt)}</strong></div>
        </div>
      </aside>
    </div>
  </section>

  <section class="block watchlist-block" aria-labelledby="watchlist-title">
    <div class="block-head">
      <div class="block-title"><span>▌</span><h2 id="watchlist-title">POOL WATCHLIST</h2></div>
      <div class="watchlist-controls">
        <label class="pool-search"><span>FIND</span><input bind:value={search} aria-label="Search pools" placeholder="ASSET / CHAIN" /></label>
        <div class="control-row trading-controls">
          <span class="control-label">TRADING</span>
          <button
            class:active={excludeHaltedChains}
            aria-pressed={excludeHaltedChains}
            title={dashboard.haltedChains.length ? `Halted: ${dashboard.haltedChains.join(', ')}` : 'No trading-halted chains reported'}
            on:click={toggleHaltedChains}
          ><i>[{excludeHaltedChains ? 'ON' : 'OFF'}]</i> HIDE HALTED</button>
        </div>
        <div class="control-row">
          <span class="control-label">COVERAGE</span>
          {#each coverageModes as mode}
            <button class:active={coverageMode === mode.id} on:click={() => coverageMode = mode.id}><i>[{mode.label}]</i></button>
          {/each}
        </div>
        <div class="control-row threshold-controls">
          <span class="control-label">THRESHOLD</span>
          {#each thresholds as value}
            <button class:active={threshold === value} on:click={() => threshold = value}><i>[{formatBasisPoints(value, { signed: false })}]</i></button>
          {/each}
        </div>
      </div>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            {#each POOL_DISLOCATION_TABLE_COLUMNS as column}
              <th aria-sort={tableSortAria(column.id)}>
                <button
                  class="table-sort"
                  class:active={tableSort.column === column.id}
                  aria-label={`Sort by ${column.label}; ${tableSort.column === column.id ? tableSortAria(column.id) : `default ${column.defaultDirection === 'asc' ? 'ascending' : 'descending'}`}`}
                  on:click={() => selectTableSort(column.id)}
                >
                  <span>{column.label}</span>
                  <i aria-hidden="true">{tableSortIndicator(column.id)}</i>
                </button>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each filteredPools as pool, index}
            {@const state = dislocationState(pool.currentAbsolute, threshold)}
            <tr class:selected={pool.asset === selectedAsset}>
              <td>
                <button class="pool-select" on:click={() => selectPool(pool.asset)} aria-label={`Show ${pool.asset} chart`}>
                  <span class="row-index">{String(index + 1).padStart(2, '0')}</span>
                  <span class="asset-symbol">{pool.symbol}</span>
                  <small>{pool.asset}</small>
                </button>
              </td>
              <td class="number">{formatPrice(pool.current?.poolPrice)}</td>
              <td class={`number ${dislocationState(pool.current?.oracleDislocation, threshold)}`}>{formatBasisPoints(pool.current?.oracleDislocation)}</td>
              <td class={`number ${dislocationState(pool.current?.binanceDislocation, threshold)}`}>{formatBasisPoints(pool.current?.binanceDislocation)}</td>
              {#each DISLOCATION_WINDOWS as window}
                <td class="number muted">{formatBasisPoints(pool.averageAbsoluteByWindow?.[window.id], { signed: false })}</td>
              {/each}
              <td class="number">{formatBasisPoints(pool.peakAbsolute, { signed: false })}</td>
              <td class="number muted">{formatHours(pool.hoursOutsideThreshold)}</td>
              <td class="spark-cell"><svg viewBox="0 0 92 26" aria-hidden="true"><line x1="0" x2="92" y1="25" y2="25"></line><path class={state} d={sparkPath(pool)} /></svg></td>
              <td><span class={`state-pill ${state}`}><i></i>{state}</span></td>
            </tr>
          {/each}
          {#if !loading && filteredPools.length === 0}
            <tr><td class="empty-row" colspan="13">NO POOLS MATCH THE CURRENT TRADING, SEARCH, AND COVERAGE FILTERS</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
    <div class="table-foot"><span>{filteredPools.length}/{dashboard.totalPools} VISIBLE POOLS</span><span>{dashboard.hiddenHaltedPools} HALTED POOLS HIDDEN · {dashboard.haltedChains.length} CHAINS</span><span>ALL TIMES UTC</span></div>
  </section>

  <footer class="method-line">
    <span>FORMULA</span>
    <code>10,000 × (TC_POOL / REFERENCE − 1) BPS</code>
    <span>WINDOW ABS = MEAN MAX SOURCE GAP</span>
    <span>GAPS ARE NOT INTERPOLATED</span>
    <span>BACKFILL = SAME-BLOCK TC/ORACLE + BINANCE 5M CLOSE</span>
    <span>POSITIVE = TC PREMIUM</span>
    <span>NEGATIVE = TC DISCOUNT</span>
  </footer>
</div>

<style>
  :global(body) { background: var(--term-bg, #080808); }

  .dashboard-shell {
    width: min(1240px, calc(100% - 40px));
    margin: 0 auto;
    padding: 24px 0 56px;
    color: var(--term-text-body, #c8c8c8);
  }

  .command-head,
  .title-row,
  .block-head,
  .control-row,
  .chart-legend,
  .table-foot,
  .method-line {
    display: flex;
    align-items: center;
  }

  .command-head {
    justify-content: space-between;
    min-height: 34px;
    padding-bottom: 11px;
    border-bottom: 1px solid var(--term-border, #1a1a1a);
    font-family: var(--term-font-mono, 'JetBrains Mono', monospace);
    font-size: 11px;
    color: var(--term-text-3, #666);
  }

  .command,
  .command span,
  .command em { font-family: inherit; }
  .command span { color: var(--term-accent, #00cc66); font-weight: 800; margin-right: 7px; }
  .command em { color: var(--term-text-5, #444); font-style: normal; }

  .command-state {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 3px 8px;
    border: 1px solid rgba(0, 204, 102, 0.35);
    border-radius: 999px;
    color: var(--term-accent, #00cc66);
    font-family: inherit;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  .command-state.degraded { border-color: var(--term-amber-edge, rgba(212, 160, 23, 0.4)); color: var(--term-amber, #d4a017); }
  .preview-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }

  .title-row { justify-content: space-between; gap: 24px; padding: 27px 0 25px; }
  h1, h2, strong, code, button, .metric-label, .metric-index, .window-stamp, .preview-alert, th, td, .reading-panel, .method-line { font-family: var(--term-font-mono, 'JetBrains Mono', monospace); }
  h1 { margin: 0; color: var(--term-text, #e8e8e8); font-size: clamp(23px, 3vw, 30px); line-height: 1.1; letter-spacing: 0.06em; }
  h1 > span:first-child { color: var(--term-accent, #00cc66); margin-right: 10px; }
  .cursor { color: var(--term-accent, #00cc66); animation: cursor-blink 1s steps(1) infinite; }
  @keyframes cursor-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
  .title-row p { margin: 9px 0 0; max-width: 660px; color: var(--term-text-3, #666); font-size: 13px; }
  .window-stamp { min-width: 132px; text-align: right; }
  .window-stamp span { display: block; color: var(--term-text-6, #333); font-size: 11px; letter-spacing: 0.14em; }
  .window-stamp strong { display: block; margin-top: 5px; color: var(--term-text-2, #888); font-size: 11px; }

  .metric-grid { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--term-border, #1a1a1a); background: var(--term-surface, #0a0a0a); }
  .metric-cell { position: relative; min-height: 116px; padding: 16px 18px; border-right: 1px solid var(--term-border, #1a1a1a); }
  .metric-cell:last-child { border-right: none; }
  .metric-index { position: absolute; top: 14px; right: 15px; color: var(--term-accent, #00cc66); font-size: 10px; font-weight: 700; }
  .metric-label { display: block; color: var(--term-text-3, #666); font-size: 11px; font-weight: 700; letter-spacing: 0.12em; }
  .metric-cell strong { display: block; margin-top: 22px; color: var(--term-text, #e8e8e8); font-size: 24px; line-height: 1; }
  .metric-cell small { display: block; margin-top: 8px; color: var(--term-text-6, #333); font-family: var(--term-font-mono, 'JetBrains Mono', monospace); font-size: 11px; line-height: 1.4; text-transform: uppercase; }

  .preview-alert { margin: 12px 0 18px; padding: 8px 11px; border-left: 2px solid var(--term-amber, #d4a017); background: var(--term-surface-deep, #050505); color: var(--term-text-3, #666); font-size: 11px; line-height: 1.5; }
  .preview-alert span { margin-right: 9px; color: var(--term-amber, #d4a017); font-weight: 800; }
  .preview-alert.syncing { border-left-color: var(--term-info, #5588cc); }
  .preview-alert.syncing span { color: var(--term-info, #5588cc); }
  .preview-alert.error { border-left-color: var(--term-error, #dc3545); }
  .preview-alert.error span { color: var(--term-error, #dc3545); }
  .preview-alert.info { border-left-color: var(--term-info, #5588cc); }
  .preview-alert.info span { color: var(--term-info, #5588cc); }
  .source-line { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 12px 0 18px; padding: 7px 10px; border-left: 2px solid var(--term-accent, #00cc66); background: var(--term-surface-deep, #050505); color: var(--term-text-5, #444); font-family: var(--term-font-mono, 'JetBrains Mono', monospace); font-size: 11px; line-height: 1.4; letter-spacing: 0.06em; }
  .source-line span:first-child { margin-right: auto; color: var(--term-text-3, #666); }

  .block { margin-top: 16px; border: 1px solid var(--term-border, #1a1a1a); background: var(--term-surface, #0a0a0a); }
  .block-head { justify-content: space-between; gap: 20px; min-height: 48px; padding: 10px 14px 10px 18px; border-bottom: 1px solid var(--term-border-faint, #111); }
  .block-title { display: flex; align-items: center; gap: 9px; }
  .block-title > span { color: var(--term-accent, #00cc66); }
  h2 { margin: 0; color: var(--term-text, #e8e8e8); font-size: 11px; letter-spacing: 0.1em; }

  .focus-controls { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px 14px; }
  .control-row { gap: 5px; }
  .control-label { margin-right: 3px; color: var(--term-text-6, #333); font-family: var(--term-font-mono, 'JetBrains Mono', monospace); font-size: 11px; letter-spacing: 0.12em; }
  .control-row button { padding: 4px 7px; border: 1px solid transparent; background: none; color: var(--term-text-4, #555); font-size: 11px; line-height: 1.4; cursor: pointer; }
  .control-row button i { color: var(--term-text-6, #333); font-family: inherit; font-style: normal; }
  .control-row button:hover,
  .control-row button.active { border-color: var(--term-border, #1a1a1a); color: var(--term-accent, #00cc66); }
  .control-row button.active i { color: var(--term-accent, #00cc66); }
  .source-unavailable { color: var(--term-text-5, #444); font-family: var(--term-font-mono, 'JetBrains Mono', monospace); font-size: 11px; letter-spacing: 0.08em; }
  .control-row button.zoom-reset { border-color: rgba(85, 136, 204, 0.35); color: var(--term-info, #5588cc); }
  .control-row button.zoom-reset i { color: inherit; }

  .focus-grid { display: grid; grid-template-columns: minmax(0, 1fr) 242px; min-height: 560px; }
  .chart-wrap { position: relative; min-width: 0; padding: 15px 17px 10px; border-right: 1px solid var(--term-border-faint, #111); overflow: hidden; }
  .chart-legend { flex-wrap: wrap; justify-content: flex-end; gap: 7px 17px; min-height: 22px; padding-right: 7px; color: var(--term-text-5, #444); font-family: var(--term-font-mono, 'JetBrains Mono', monospace); font-size: 11px; line-height: 1.4; letter-spacing: 0.06em; }
  .chart-legend span { display: inline-flex; align-items: center; gap: 6px; font-family: inherit; }
  .chart-legend .zoom-hint { margin-right: auto; color: var(--term-text-6, #333); }
  .chart-legend .trend-key { display: inline-flex; align-items: center; gap: 6px; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; letter-spacing: inherit; cursor: pointer; }
  .chart-legend .trend-key:hover { color: var(--term-text-2, #d8d8d8); }
  .chart-legend .trend-key:focus-visible { outline: 1px solid var(--term-accent, #00cc66); outline-offset: 3px; }
  .chart-legend .trend-key.is-hidden { color: var(--term-text-6, #333); text-decoration: line-through; opacity: 0.62; }
  .chart-legend .trend-key.is-hidden i { opacity: 0.4; }
  .chart-legend i { display: inline-block; width: 16px; height: 2px; background: var(--term-accent, #00cc66); }
  .chart-legend .binance-key i { background: var(--term-info, #5588cc); }
  .chart-legend .average-key i { background: repeating-linear-gradient(90deg, var(--term-text-3, #666) 0 7px, transparent 7px 10px); }
  .chart-legend .average-key.avg-6h i { background: repeating-linear-gradient(90deg, var(--term-text-3, #666) 0 4px, transparent 4px 8px); }
  .chart-legend .average-key.avg-1d i { background: repeating-linear-gradient(90deg, var(--term-text-3, #666) 0 2px, transparent 2px 6px); }
  .chart-legend .minbps-key i { height: 5px; border: 1px solid rgba(232, 232, 232, 0.42); background: rgba(232, 232, 232, 0.07); }
  .chart-wrap svg { display: block; width: 100%; height: auto; min-height: 450px; }
  .minbps-zone { fill: rgba(232, 232, 232, 0.035); pointer-events: none; }
  .grid-line { stroke: var(--term-border-faint, #111); stroke-width: 1; }
  .grid-line.zero { stroke: var(--term-text-5, #444); stroke-dasharray: 4 5; }
  .minbps-line { stroke: rgba(232, 232, 232, 0.48); stroke-width: 1; stroke-dasharray: 1 4; pointer-events: none; }
  .minbps-axis-label { fill: var(--term-text-3, #bcbcbc); text-anchor: end; font: 11px 'JetBrains Mono', monospace; letter-spacing: 0.02em; pointer-events: none; }
  .x-tick { stroke: var(--term-border, #1a1a1a); }
  .axis-label { fill: var(--term-text-5, #444); font: 11px 'JetBrains Mono', monospace; }
  .axis-label.y { text-anchor: end; }
  .axis-label.x { text-anchor: middle; }
  .series { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .series.oracle { stroke: var(--term-accent, #00cc66); }
  .series.binance { stroke: var(--term-info, #5588cc); }
  .series.rolling-average { stroke-width: 2.25; opacity: 0.9; pointer-events: none; }
  .series.rolling-average.avg-1h { stroke-dasharray: 8 3; }
  .series.rolling-average.avg-6h { stroke-dasharray: 4 4; }
  .series.rolling-average.avg-1d { stroke-dasharray: 2 5; }
  .point { stroke: var(--term-bg, #080808); stroke-width: 1.5; }
  .point.oracle { fill: var(--term-accent, #00cc66); }
  .point.binance { fill: var(--term-info, #5588cc); }
  .hover-crosshair { stroke: rgba(232, 232, 232, 0.4); stroke-width: 1; stroke-dasharray: 3 3; pointer-events: none; }
  .hover-point { stroke: var(--term-bg, #080808); stroke-width: 2; pointer-events: none; }
  .hover-point.oracle { fill: var(--term-accent, #00cc66); }
  .hover-point.binance { fill: var(--term-info, #5588cc); }
  .zoom-selection { fill: rgba(85, 136, 204, 0.14); stroke: rgba(85, 136, 204, 0.85); stroke-width: 1; stroke-dasharray: 4 3; pointer-events: none; }
  .chart-hitbox { fill: transparent; cursor: crosshair; touch-action: pan-y; }
  .chart-tooltip { position: absolute; z-index: 3; top: 52px; width: 248px; padding: 10px 11px; border: 1px solid var(--term-border, #1a1a1a); background: rgba(5, 5, 5, 0.96); box-shadow: 0 8px 22px rgba(0, 0, 0, 0.45); color: var(--term-text-2, #888); font-family: var(--term-font-mono, 'JetBrains Mono', monospace); font-size: 11px; line-height: 1.4; pointer-events: none; transform: translateX(10px); }
  .chart-tooltip.right { transform: translateX(calc(-100% - 10px)); }
  .chart-tooltip > strong { display: block; margin-bottom: 7px; padding-bottom: 7px; border-bottom: 1px solid var(--term-border-faint, #111); color: var(--term-text, #e8e8e8); font-size: 11px; letter-spacing: 0.04em; }
  .chart-tooltip > div { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
  .chart-tooltip span { color: var(--term-text-5, #444); letter-spacing: 0.06em; }
  .chart-tooltip span small { display: block; margin-top: 2px; color: var(--term-text-6, #333); font: inherit; letter-spacing: 0.03em; }
  .chart-tooltip span small.partial { color: var(--term-amber, #d4a017); }
  .chart-tooltip b { color: var(--term-text-2, #888); font-weight: 700; }
  .chart-status { position: absolute; inset: 54px 17px 35px; display: grid; place-items: center; background: rgba(5, 5, 5, 0.74); color: var(--term-text-4, #555); font-family: var(--term-font-mono, 'JetBrains Mono', monospace); font-size: 11px; line-height: 1.5; letter-spacing: 0.08em; text-align: center; }
  .chart-status.error { color: var(--term-error, #dc3545); }

  .reading-panel { padding: 17px 16px; background: var(--term-surface-deep, #050505); }
  .reading-head { display: flex; justify-content: space-between; color: var(--term-text-6, #333); font-size: 11px; line-height: 1.4; letter-spacing: 0.12em; }
  .reading-head strong { color: var(--term-amber, #d4a017); font-size: 11px; }
  .price-stack { margin-top: 18px; }
  .price-stack > div { display: flex; justify-content: space-between; align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--term-border-faint, #111); }
  .price-stack span,
  .delta-stack span,
  .reading-foot span { color: var(--term-text-5, #444); font-family: inherit; font-size: 11px; line-height: 1.4; letter-spacing: 0.08em; }
  .price-stack strong { color: var(--term-text-2, #888); font-size: 11px; }
  .delta-stack { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; margin: 18px -16px 0; border-top: 1px solid var(--term-border-faint, #111); border-bottom: 1px solid var(--term-border-faint, #111); background: var(--term-border-faint, #111); }
  .delta-stack > div { padding: 13px 10px; background: var(--term-surface, #0a0a0a); }
  .delta-stack span,
  .delta-stack strong { display: block; }
  .delta-stack strong { margin-top: 8px; color: var(--term-text, #e8e8e8); font-size: 15px; }
  .reading-foot { padding-top: 13px; }
  .reading-foot > div { display: flex; justify-content: space-between; padding: 6px 0; }
  .reading-foot strong { color: var(--term-text-2, #888); font-size: 11px; }

  .table-scroll { overflow-x: auto; }
  .watchlist-controls { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px 12px; }
  .pool-search { display: inline-flex; align-items: center; gap: 6px; font-family: var(--term-font-mono, 'JetBrains Mono', monospace); }
  .pool-search span { color: var(--term-text-6, #333); font-size: 11px; letter-spacing: 0.12em; }
  .pool-search input { width: 136px; padding: 6px 8px; border: 1px solid var(--term-border, #1a1a1a); border-radius: 0; outline: none; background: var(--term-surface-deep, #050505); color: var(--term-text-2, #888); font-family: inherit; font-size: 11px; text-transform: uppercase; }
  .pool-search input:focus { border-color: rgba(0, 204, 102, 0.45); }
  table { width: 100%; min-width: 1320px; border-collapse: collapse; }
  th { position: sticky; top: 0; z-index: 1; padding: 0; border-bottom: 1px solid var(--term-border, #1a1a1a); background: var(--term-surface, #0a0a0a); color: var(--term-text-5, #444); font-size: 11px; line-height: 1.4; text-align: right; letter-spacing: 0.08em; white-space: nowrap; }
  th:first-child { text-align: left; }
  .table-sort { display: flex; align-items: center; justify-content: flex-end; gap: 6px; width: 100%; padding: 10px 12px; border: 0; background: none; color: inherit; font-family: inherit; font-size: inherit; letter-spacing: inherit; white-space: nowrap; cursor: pointer; }
  th:first-child .table-sort { justify-content: flex-start; padding-left: 18px; }
  .table-sort i { min-width: 8px; color: var(--term-text-7, #222); font-style: normal; text-align: center; }
  .table-sort:hover,
  .table-sort.active { color: var(--term-accent, #00cc66); }
  .table-sort.active i { color: inherit; }
  td { padding: 10px 12px; border-bottom: 1px solid var(--term-border-faint, #111); color: var(--term-text-2, #888); font-size: 11px; line-height: 1.4; text-align: right; white-space: nowrap; }
  tbody tr { transition: background var(--term-transition, 0.15s ease); }
  tbody tr:hover,
  tbody tr.selected { background: var(--term-surface-hover, #0d0d0d); }
  tbody tr.selected td:first-child { box-shadow: inset 2px 0 0 var(--term-accent, #00cc66); }
  tbody tr:last-child td { border-bottom: none; }
  td:first-child { padding-left: 10px; text-align: left; }
  .pool-select { display: grid; grid-template-columns: 22px 44px auto; align-items: center; width: 100%; padding: 0 7px; border: 0; background: none; cursor: pointer; text-align: left; }
  .pool-select:hover .asset-symbol { color: var(--term-accent, #00cc66); }
  .row-index { color: var(--term-text-7, #222); font-size: 10px; }
  .asset-symbol { color: var(--term-text, #e8e8e8); font-weight: 800; }
  .pool-select small { color: var(--term-text-6, #333); font-family: inherit; font-size: 11px; }
  .number { font-variant-numeric: tabular-nums; }
  .muted { color: var(--term-text-5, #444); }
  .normal { color: var(--term-accent, #00cc66) !important; }
  .watch { color: var(--term-amber, #d4a017) !important; }
  .critical { color: var(--term-error, #dc3545) !important; }
  .missing { color: var(--term-text-6, #333) !important; }
  .spark-cell { width: 112px; }
  .spark-cell svg { display: block; width: 92px; height: 26px; margin-left: auto; }
  .spark-cell line { stroke: var(--term-border-faint, #111); }
  .spark-cell path { fill: none; stroke: var(--term-accent, #00cc66); stroke-width: 1.3; }
  .spark-cell path.watch { stroke: var(--term-amber, #d4a017); }
  .spark-cell path.critical { stroke: var(--term-error, #dc3545); }
  .state-pill { display: inline-flex; align-items: center; gap: 6px; min-width: 78px; padding: 3px 7px; border: 1px solid var(--term-border, #1a1a1a); border-radius: 999px; color: var(--term-text-4, #555); font-family: inherit; font-size: 11px; line-height: 1.4; text-transform: uppercase; }
  .state-pill i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .empty-row { height: 80px; color: var(--term-text-5, #444); text-align: center !important; letter-spacing: 0.08em; }
  .table-foot { justify-content: space-between; gap: 16px; min-height: 39px; padding: 0 17px; border-top: 1px solid var(--term-border-faint, #111); color: var(--term-text-6, #333); font-size: 11px; line-height: 1.4; letter-spacing: 0.07em; }

  .method-line { flex-wrap: wrap; gap: 14px; margin-top: 14px; padding: 9px 0; border-top: 1px solid var(--term-border-faint, #111); color: var(--term-text-6, #333); font-size: 11px; line-height: 1.5; }
  .method-line > span:first-child { color: var(--term-accent, #00cc66); font-weight: 800; }
  .method-line code { padding: 2px 5px; border: 1px solid var(--term-border, #1a1a1a); background: var(--term-surface, #0a0a0a); color: var(--term-text-3, #666); font-size: 11px; }

  @media (max-width: 980px) {
    .metric-grid { grid-template-columns: repeat(2, 1fr); }
    .metric-cell:nth-child(2) { border-right: none; }
    .metric-cell:nth-child(-n + 2) { border-bottom: 1px solid var(--term-border, #1a1a1a); }
    .focus-grid { grid-template-columns: 1fr; }
    .chart-wrap { border-right: 0; border-bottom: 1px solid var(--term-border-faint, #111); }
    .reading-panel { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 24px; }
    .reading-head { grid-column: 1 / -1; }
    .price-stack { margin-top: 0; }
    .delta-stack { margin: 0; }
    .reading-foot { grid-column: 1 / -1; }
  }

  @media (max-width: 640px) {
    .dashboard-shell { width: min(100% - 24px, 1240px); padding-top: 16px; }
    .command-head { align-items: flex-start; gap: 10px; }
    .command em { display: none; }
    .title-row { align-items: flex-end; padding: 22px 0 20px; }
    .title-row p { font-size: 13px; }
    .window-stamp { min-width: auto; }
    .metric-grid { grid-template-columns: 1fr; }
    .metric-cell,
    .metric-cell:nth-child(2) { min-height: 102px; border-right: none; border-bottom: 1px solid var(--term-border, #1a1a1a); }
    .metric-cell:last-child { border-bottom: 0; }
    .block-head { align-items: flex-start; flex-direction: column; gap: 10px; }
    .focus-controls { justify-content: flex-start; }
    .watchlist-controls { justify-content: flex-start; }
    .chart-wrap { padding-left: 4px; padding-right: 4px; overflow-x: auto; }
    .chart-legend { justify-content: center; gap: 10px; }
    .chart-wrap svg { width: 720px; min-width: 720px; min-height: 360px; }
    .reading-panel { display: block; }
    .price-stack { margin-top: 16px; }
    .delta-stack { margin: 16px -16px 0; }
    .table-foot { justify-content: flex-start; }
    .table-foot span:nth-child(2) { display: none; }
  }
</style>
