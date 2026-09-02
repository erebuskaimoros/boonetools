<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { createVisiblePoll } from './utils/visible-poll.js';
  import { formatNumber, formatUSD, formatUSDCompact } from '$lib/utils/formatting';
  import { fromBaseUnit } from '$lib/utils/blockchain';
  import {
    fetchRapidSwapsDashboard,
    fetchRapidSwapsSwapHistory,
    getRapidSwapsApiConfigError
  } from './rapid-swaps/api.js';
  import {
    computeDailyBucketData,
    computeDailyData,
    getSeriesAxisBounds,
    getChartDateRangeUnixSeconds,
    toChartDateKey
  } from './rapid-swaps/charts.js';
  import {
    computeDistributions,
    computeSwapPathData,
    distributionsFromPreaggregates,
    formatTimeSaved,
    getTxUrl,
    shortPair,
    swapPctFaster,
    swapTimeSaved,
    swapVolumeUsd,
    swapPathDataFromPreaggregates
  } from './rapid-swaps/presentation.js';
  import { createRapidSwapChartRenderer } from './rapid-swaps/chart-renderer.js';

  const REFRESH_INTERVAL_MS = 120000;
  const TABLE_RELOAD_DEBOUNCE_MS = 350;
  const PAGE_SIZE = 20;

  // --- State ---
  let loading = true;
  let refreshing = false;
  let dashboard = null;
  let dashboardError = '';
  let refreshInterval;
  let historyRefreshInterval;
  let tableReloadTimer = null;
  let dashboardRequestId = 0;
  let midgardHistoryRequestId = 0;

  // Tabs
  let activeTab = 'overview';

  // Overview date range filter (defaults to last 7 local days inclusive of today)
  let todayDateKey = toChartDateKey(new Date());
  let overviewDateFrom = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return toChartDateKey(d);
  })();
  let overviewDateTo = toChartDateKey(new Date());
  let overviewDateToPinnedToToday = true;

  // Table filters + sorting
  let filterPath = '';
  let filterMinUsd = '';
  let filterMinSubs = '';
  let currentPage = 1;
  let sortColumn = 'date';
  let sortAsc = false;

  // Backend-cached total swap history (for market share charts)
  let midgardSwapHistory = null;

  $: chartBuckets = dashboard?.chart_buckets || [];
  $: allSwaps = dashboard?.chart_swaps?.length
    ? dashboard.chart_swaps
    : dashboard?.recent_24h?.length
      ? dashboard.recent_24h
      : dashboard?.all_swaps || [];
  $: tableSwaps = dashboard?.all_swaps || [];
  $: paginationMeta = dashboard?.pagination || {};
  $: topSwaps = dashboard?.top_20 || [];
  $: recentSwaps = dashboard?.recent_24h || [];
  $: trackerStart = dashboard?.tracker_started_at || null;
  $: backendMeta = dashboard?.backend || null;
  $: liveTailMeta = backendMeta?.live_tail || backendMeta?.last_run_stats?.live_tail || backendMeta?.canonical_sync?.stats?.live_tail || null;
  $: canonicalSourceMeta = backendMeta?.canonical_source || null;
  $: sourceStatus = dashboard?.chain_status || dashboard?.source_status || backendMeta?.source_status || null;
  $: sourceBanner = getSourceBanner(sourceStatus, backendMeta);
  $: backendConfigError = getRapidSwapsApiConfigError();

  // Filtered + sorted + paginated table data
  $: filteredSwaps = tableSwaps;
  $: sortedSwaps = tableSwaps;
  $: tableTotal = Number(paginationMeta.total) || tableSwaps.length;
  $: totalPages = Math.max(1, Number(paginationMeta.total_pages) || Math.ceil(tableTotal / PAGE_SIZE));
  $: {
    if (currentPage > totalPages) currentPage = 1;
  }
  $: pagedSwaps = tableSwaps;

  // Filter swaps by overview date range
  $: overviewSwaps = allSwaps.filter(s => {
    const d = toChartDateKey(s.action_date);
    return d >= overviewDateFrom && d <= overviewDateTo;
  });
  $: overviewBuckets = chartBuckets.filter((bucket) => {
    const key = String(bucket?.bucket_start || '').slice(0, 10);
    return key >= overviewDateFrom && key <= overviewDateTo;
  });

  // Daily aggregates for charts (includes market share when midgard data available)
  $: dailyData = chartBuckets.length
    ? computeDailyBucketData(overviewBuckets, midgardSwapHistory, {
        cumulativeCountBefore: dashboard?.chart?.cumulative_count_before || 0,
        cumulativeVolumeBefore:
          dashboard?.chart?.cumulative_leg_volume_usd_before
          ?? dashboard?.chart?.cumulative_volume_usd_before
          ?? 0
      })
    : computeDailyData(overviewSwaps, midgardSwapHistory, allSwaps, {
        useCumulativeSeeds: Boolean(dashboard?.chart),
        cumulativeCountBefore: dashboard?.chart?.cumulative_count_before || 0,
        cumulativeVolumeBefore:
          dashboard?.chart?.cumulative_leg_volume_usd_before
          ?? dashboard?.chart?.cumulative_volume_usd_before
          ?? 0
      });
  $: cumulativeVolumeAxisBounds = getSeriesAxisBounds(dailyData.cumVolume, {
    clampMin: 0,
    minSpan: 1
  });
  $: cumulativeCountAxisBounds = getSeriesAxisBounds(dailyData.cumCount, {
    clampMin: 0,
    minSpan: 1,
    roundToInteger: true
  });
  $: hasAdoptionData =
    dailyData.volumePct.some(value => Number.isFinite(value)) ||
    dailyData.countPct.some(value => Number.isFinite(value));
  // Distribution data
  $: distributions = dashboard?.preaggregates
    ? distributionsFromPreaggregates(dashboard.preaggregates)
    : computeDistributions(overviewSwaps);
  $: hasDistributionData = Boolean(distributions.subLabels?.length || distributions.timeLabels?.length);
  // Swap path data
  $: swapPathData = dashboard?.preaggregates
    ? swapPathDataFromPreaggregates(dashboard.preaggregates)
    : computeSwapPathData(overviewSwaps);
  $: hasPathData = Boolean(swapPathData.volumeLabels?.length || swapPathData.sankeyFlows?.length);

  // --- Helpers ---
  function formatAmount(amountBase, maxFractionDigits = 4) {
    return formatNumber(fromBaseUnit(amountBase || 0), {
      maximumFractionDigits: maxFractionDigits
    });
  }

  function formatDateTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '-';
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function formatFreshness(seconds) {
    const numeric = Number(seconds);
    if (!Number.isFinite(numeric) || numeric < 0) return 'No runs yet';
    if (numeric < 60) return `${numeric}s old`;
    if (numeric < 3600) return `${Math.floor(numeric / 60)}m old`;
    return `${Math.floor(numeric / 3600)}h old`;
  }

  function ageSeconds(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? Math.max(0, Math.floor((Date.now() - parsed) / 1000)) : -1;
  }

  function formatHeight(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? formatNumber(numeric, { maximumFractionDigits: 0 }) : 'unknown';
  }

  function sourceStatusLabel(status) {
    const value = status?.status || '';
    if (value === 'halted_idle') return 'HALTED';
    if (value === 'degraded') return 'DEGRADED';
    if (value === 'active') return 'ACTIVE';
    return 'UNKNOWN';
  }

  function getSourceBanner(status, backend) {
    const skipReason = backend?.last_run_stats?.skip_reason || '';
    if (status?.provider === 'dune' || (status?.provider === 'hybrid' && status?.status === 'active')) {
      return null;
    }

    const latestAction = status?.midgard?.latest_swap_action || null;
    const latestDate = latestAction?.date ? formatDateTime(latestAction.date) : '';
    const latestHeight = formatHeight(latestAction?.height);

    if (status?.status === 'halted_idle') {
      const haltBits = [
        status.trading_halted ? 'trading halted' : '',
        status.signing_halted ? 'signing halted' : ''
      ].filter(Boolean).join(' / ');

      return {
        tone: 'warn',
        title: 'THORCHAIN TRADING HALTED',
        body: `No new completed rapid swaps are expected while ${haltBits || 'chain swap paths are halted'}. Latest Midgard swap action: ${latestDate || 'unknown time'} at height ${latestHeight}.`
      };
    }

    if (skipReason === 'rate_limited' || status?.midgard?.status === 'rate_limited' || status?.live_tail?.status === 'rate_limited') {
      return {
        tone: 'err',
        title: 'PROVIDER COOLDOWN ACTIVE',
        body: 'Midgard returned a rate limit. The live tail is backing off while canonical Dune sync stays available.'
      };
    }

    if (status?.status === 'degraded') {
      return {
        tone: 'warn',
        title: 'SOURCE STATUS DEGRADED',
        body: 'The recorder is running, but one or more THORChain data sources could not be checked on the last scheduler pass.'
      };
    }

    return null;
  }

  function clearFilters() {
    filterPath = '';
    filterMinUsd = '';
    filterMinSubs = '';
    currentPage = 1;
    loadData(false, { reloadHistory: false });
  }

  function toggleSort(col) {
    if (sortColumn === col) {
      sortAsc = !sortAsc;
    } else {
      sortColumn = col;
      sortAsc = col === 'date' ? false : col === 'pair' ? true : false;
    }
    currentPage = 1;
    loadData(false, { reloadHistory: false });
  }

  function scheduleTableReload() {
    currentPage = 1;
    clearTimeout(tableReloadTimer);
    tableReloadTimer = setTimeout(() => {
      loadData(false, { reloadHistory: false });
    }, TABLE_RELOAD_DEBOUNCE_MS);
  }

  function goToPage(page) {
    const nextPage = Math.min(totalPages, Math.max(1, Number(page) || 1));
    if (nextPage === currentPage) {
      return;
    }

    currentPage = nextPage;
    loadData(false, { reloadHistory: false });
  }

  const chartRenderer = createRapidSwapChartRenderer();

  async function renderChartsForTab(tab) {
    await tick();
    if (tab === 'overview') {
      chartRenderer.renderOverview({
        dailyData,
        cumulativeVolumeAxisBounds,
        cumulativeCountAxisBounds,
        hasAdoptionData
      });
    } else if (tab === 'distributions') {
      chartRenderer.renderDistributions(distributions);
    } else if (tab === 'paths') {
      chartRenderer.renderPaths(swapPathData);
    }
  }

  $: if (dashboard && activeTab) {
    midgardSwapHistory; // re-render when midgard data arrives
    overviewDateFrom; overviewDateTo; // re-render when date range changes
    renderChartsForTab(activeTab);
  }

  async function loadMidgardSwapHistory() {
    const swaps = allSwaps;
    if ((!swaps.length && !chartBuckets.length) || !overviewDateFrom || !overviewDateTo || overviewDateFrom > overviewDateTo) {
      midgardSwapHistory = null;
      return;
    }

    const range = getChartDateRangeUnixSeconds(overviewDateFrom, overviewDateTo, { utc: true });
    if (!range) {
      midgardSwapHistory = null;
      return;
    }

    const requestId = ++midgardHistoryRequestId;

    try {
      const history = await fetchRapidSwapsSwapHistory({
        interval: 'hour',
        from: range.from,
        to: range.to
      });

      if (requestId !== midgardHistoryRequestId) {
        return;
      }

      midgardSwapHistory = history;
    } catch (_) {
      if (requestId !== midgardHistoryRequestId) {
        return;
      }

      // Non-critical — market share charts just won't render
      midgardSwapHistory = null;
    }
  }

  function buildDashboardParams() {
    const params = {
      include_all: 'false',
      limit: PAGE_SIZE,
      offset: Math.max(0, (currentPage - 1) * PAGE_SIZE),
      sort: sortColumn,
      order: sortAsc ? 'asc' : 'desc'
    };

    if (filterPath.trim()) {
      params.path = filterPath.trim();
    }

    if (Number(filterMinUsd) > 0) {
      params.min_usd = Number(filterMinUsd);
    }

    if (Number(filterMinSubs) > 0) {
      params.min_subs = Number(filterMinSubs);
    }

    const chartRange = getChartDateRangeUnixSeconds(overviewDateFrom, overviewDateTo, { utc: true });
    if (chartRange) {
      params.chart_from = chartRange.from;
      params.chart_to = chartRange.to;
    }

    return params;
  }

  function refreshTodayDateKey() {
    todayDateKey = toChartDateKey(new Date());
    return todayDateKey;
  }

  function handleOverviewDateFromChange() {
    const today = refreshTodayDateKey();
    if (overviewDateFrom > today) {
      overviewDateFrom = today;
    }

    if (overviewDateFrom > overviewDateTo) {
      overviewDateTo = overviewDateFrom;
      overviewDateToPinnedToToday = overviewDateTo === today;
    }

    loadData(false);
  }

  function handleOverviewDateToChange() {
    const today = refreshTodayDateKey();
    if (overviewDateTo > today) {
      overviewDateTo = today;
    }

    overviewDateToPinnedToToday = overviewDateTo === today;

    if (overviewDateTo < overviewDateFrom) {
      overviewDateFrom = overviewDateTo;
    }

    loadData(false);
  }

  // --- Data loading ---
  async function loadData(showLoading = true, options = {}) {
    if (showLoading) loading = true;
    else refreshing = true;
    const requestId = ++dashboardRequestId;
    try {
      // Keep the default range pinned to today, but preserve a user-selected historical end date.
      const today = refreshTodayDateKey();
      if (overviewDateTo > today) {
        overviewDateTo = today;
        overviewDateToPinnedToToday = true;
      } else if (overviewDateToPinnedToToday && overviewDateTo < today) {
        overviewDateTo = today;
      }

      const nextDashboard = await fetchRapidSwapsDashboard({
        params: buildDashboardParams()
      });
      if (requestId !== dashboardRequestId) {
        return;
      }
      dashboard = nextDashboard;
      dashboardError = '';
      await tick();

      if (options.reloadHistory !== false) {
        await loadMidgardSwapHistory();
      }
    } catch (err) {
      if (requestId !== dashboardRequestId) {
        return;
      }
      dashboard = null;
      dashboardError = err?.message || 'Failed to load recorded rapid swaps';
      midgardSwapHistory = null;
    } finally {
      if (requestId === dashboardRequestId) {
        loading = false;
        refreshing = false;
      }
    }
  }

  onMount(() => {
    loadData(true);
    refreshInterval = createVisiblePoll(() => loadData(false, { reloadHistory: false }), { intervalMs: REFRESH_INTERVAL_MS, immediate: false });
    historyRefreshInterval = createVisiblePoll(loadMidgardSwapHistory, { intervalMs: 30 * 60_000, immediate: false });
    return () => {
      refreshInterval?.stop();
      historyRefreshInterval?.stop();
      clearTimeout(tableReloadTimer);
      chartRenderer.destroyAll();
    };
  });
</script>

<div class="rs">
  <!-- Status bar -->
  <div class="status-bar">
    <span class="status-left">
      {#if dashboard}
        <span class="status-dot" class:ok={backendMeta?.last_run_status === 'success'} class:err={backendMeta?.last_run_status !== 'success'}></span>
        RECORDER {backendMeta?.last_run_status === 'success' ? 'OK' : 'ERR'}
        <span class="sep">|</span>
        {formatFreshness(backendMeta?.freshness_seconds)}
        {#if liveTailMeta}
          <span class="sep">|</span>
          LIVE {formatFreshness(ageSeconds(liveTailMeta.last_scanned_at))}
          {#if liveTailMeta.status && liveTailMeta.status !== 'active'}
            <span class="warn-text">{String(liveTailMeta.status).toUpperCase()}</span>
          {/if}
        {/if}
        {#if canonicalSourceMeta?.last_scanned_at}
          <span class="sep">|</span>
          DUNE {formatFreshness(ageSeconds(canonicalSourceMeta.last_scanned_at))}
        {/if}
        {#if trackerStart}
          <span class="sep">|</span>
          since {formatDateTime(trackerStart)}
        {/if}
        {#if !dashboard?.tracker_warmup_complete}
          <span class="sep">|</span>
          <span class="warn-text">warming up</span>
        {/if}
        {#if sourceStatus?.status}
          <span class="sep">|</span>
          <span class={sourceStatus.status !== 'active' ? 'warn-text' : ''}>SOURCE {sourceStatusLabel(sourceStatus)}</span>
        {/if}
      {:else if dashboardError}
        <span class="status-dot err"></span>
        RECORDER OFFLINE
      {:else}
        <span class="status-dot"></span>
        CONNECTING...
      {/if}
    </span>
    <span class="status-right">
      <span class="ws-badge ws-ok">
        <span class="ws-dot"></span>
        CACHED READ MODEL
      </span>
      {#if refreshing}
        <span class="sep">|</span> REFRESHING...
      {/if}
    </span>
  </div>

  {#if sourceBanner}
    <div class={`source-banner ${sourceBanner.tone === 'warn' ? 'source-banner-warn' : ''} ${sourceBanner.tone === 'err' ? 'source-banner-err' : ''}`}>
      <div class="source-banner-title">{sourceBanner.title}</div>
      <div class="source-banner-body">{sourceBanner.body}</div>
    </div>
  {/if}

  <!-- Sticky header: metrics + tabs -->
  <div class="sticky-header">
  <div class="metrics">
    <div class="metric">
      <div class="metric-val">{formatNumber(dashboard?.recent_24h_count || 0, { maximumFractionDigits: 0 })}</div>
      <div class="metric-key">24H COUNT</div>
    </div>
    <div class="metric">
      <div class="metric-val">{formatUSDCompact(dashboard?.recent_24h_leg_volume_usd ?? dashboard?.recent_24h_volume_usd ?? 0)}</div>
      <div class="metric-key">24H VOLUME</div>
    </div>
    <div class="metric">
      <div class="metric-val accent">{formatNumber(dashboard?.total_tracked || 0, { maximumFractionDigits: 0 })}</div>
      <div class="metric-key">TOTAL SWAPS</div>
    </div>
    <div class="metric">
      <div class="metric-val accent">{formatUSDCompact(dashboard?.cumulative_leg_volume_usd ?? dashboard?.cumulative_volume_usd ?? 0)}</div>
      <div class="metric-key">ALL-TIME VOLUME</div>
    </div>
    <div class="metric">
      <div class="metric-val amber">{formatTimeSaved(dashboard?.time_saved_seconds || 0)}</div>
      <div class="metric-key">TIME SAVED</div>
      <div class="metric-sub">{formatTimeSaved(dashboard?.baseline_seconds || 0)} at interval=1</div>
    </div>
    <div class="metric">
      <div class="metric-val amber">{dashboard?.pct_faster || 0}%</div>
      <div class="metric-key">FASTER</div>
      <div class="metric-sub">{formatTimeSaved(dashboard?.actual_seconds || 0)} actual vs {formatTimeSaved(dashboard?.baseline_seconds || 0)}</div>
    </div>
    <div class="metric metric-largest">
      <div class="metric-val">{topSwaps[0] ? formatUSDCompact(swapVolumeUsd(topSwaps[0])) : '--'}</div>
      <div class="metric-key">LARGEST SWAP</div>
      {#if topSwaps[0]}
        <div class="metric-sub">{shortPair(topSwaps[0])}</div>
        <div class="metric-stats">
          <span>{topSwaps[0].streaming_count} subs</span>
          <span class="sep">·</span>
          <span>{topSwaps[0].blocks_used} blks</span>
          <span class="sep">·</span>
          <span>{Number(topSwaps[0].blocks_used) > 0 ? (Number(topSwaps[0].streaming_count) / Number(topSwaps[0].blocks_used)).toFixed(1) : '--'}x eff</span>
          <span class="sep">·</span>
          <span class="amber">{formatTimeSaved(swapTimeSaved(topSwaps[0]))} saved</span>
          <span class="sep">·</span>
          <span class="amber">{swapPctFaster(topSwaps[0])}% faster</span>
        </div>
      {/if}
    </div>
  </div>

  <!-- Tab bar -->
  <div class="tab-bar">
    <div class="tab-btns">
      <button class="tab-btn" class:tab-active={activeTab === 'overview'} on:click={() => activeTab = 'overview'}>Overview</button>
      <button class="tab-btn" class:tab-active={activeTab === 'distributions'} on:click={() => activeTab = 'distributions'}>Distributions</button>
      <button class="tab-btn" class:tab-active={activeTab === 'paths'} on:click={() => activeTab = 'paths'}>Swap Paths</button>
    </div>
    {#if activeTab === 'overview'}
      <div class="date-range">
        <input type="date" class="date-input" bind:value={overviewDateFrom} max={todayDateKey} on:change={handleOverviewDateFromChange} />
        <span class="date-sep">–</span>
        <input type="date" class="date-input" bind:value={overviewDateTo} max={todayDateKey} on:change={handleOverviewDateToChange} />
      </div>
    {:else}
      <div class="date-range">ALL RECORDED SWAPS</div>
    {/if}
  </div>
  </div><!-- /sticky-header -->

  <!-- Tab panels -->
  {#if activeTab === 'overview'}
    <!-- Daily Trends -->
    <section class="data-section">
      <div class="section-head">
        <h3>DAILY TRENDS</h3>
        <span class="section-sub">Grouped by UTC day</span>
      </div>
      {#if loading && !dashboard}
        <div class="empty">Loading...</div>
      {:else if !dailyData.labels.length}
        <div class="empty">No swap data available.</div>
      {:else}
        <div class="chart-grid">
          <div class="chart-card">
            <div class="chart-title">Rapid Swap Volume</div>
            <div class="chart-container"><canvas id="chart-daily-volume"></canvas></div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Rapid Swap Count</div>
            <div class="chart-container"><canvas id="chart-daily-count"></canvas></div>
          </div>
        </div>
      {/if}
    </section>

    <!-- Market Share -->
    {#if dailyData.labels.length}
      <section class="data-section">
        <div class="section-head">
          <h3>ADOPTION</h3>
          <span class="section-sub">Rapid swaps as percentage of total THORChain activity, grouped by UTC day</span>
        </div>
        {#if hasAdoptionData}
          <div class="chart-grid">
            <div class="chart-card">
              <div class="chart-title">% of TC Volume</div>
              <div class="chart-container"><canvas id="chart-market-share-volume"></canvas></div>
            </div>
            <div class="chart-card">
              <div class="chart-title">% of TC Swap Count</div>
              <div class="chart-container"><canvas id="chart-market-share-count"></canvas></div>
            </div>
          </div>
        {:else}
          <div class="empty">THORChain adoption totals are temporarily unavailable.</div>
        {/if}
      </section>
    {/if}

    <!-- Execution Efficiency -->
    <section class="data-section">
      <div class="section-head">
        <h3>EXECUTION EFFICIENCY</h3>
        <span class="section-sub">Sub-swaps per block used (higher is better)</span>
      </div>
      {#if dailyData.labels.length}
        <div class="chart-grid">
          <div class="chart-card">
            <div class="chart-title">Efficiency Ratio</div>
            <div class="chart-container"><canvas id="chart-efficiency"></canvas></div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Average % Faster</div>
            <div class="chart-container"><canvas id="chart-pct-faster"></canvas></div>
          </div>
        </div>
      {/if}
    </section>

    <!-- Swaps Table -->
    <section class="data-section">
      <div class="section-head">
        <h3>RAPID SWAPS</h3>
        <span class="section-sub">Showing {pagedSwaps.length} of {tableTotal} matching swaps · {formatNumber(dashboard?.total_tracked || 0, { maximumFractionDigits: 0 })} total · timestamps shown in your local time</span>
      </div>

      <div class="table-filters">
        <input type="text" class="filter-input" placeholder="Filter by swap path" bind:value={filterPath} on:input={scheduleTableReload} />
        <input type="number" class="filter-input filter-num" placeholder="Min USD volume" bind:value={filterMinUsd} on:input={scheduleTableReload} />
        <input type="number" class="filter-input filter-num" placeholder="Min sub-swaps" bind:value={filterMinSubs} on:input={scheduleTableReload} />
        {#if filterPath || filterMinUsd || filterMinSubs}
          <button class="filter-clear" on:click={clearFilters}>Clear Filters</button>
        {/if}
      </div>

      {#if loading && !dashboard}
        <div class="empty">Loading...</div>
      {:else if dashboardError}
        <div class="empty err-text">{dashboardError}</div>
      {:else if tableTotal === 0}
        <div class="empty">No rapid swaps match the current filters.</div>
      {:else}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="col-when sortable" class:sort-active={sortColumn === 'date'} on:click={() => toggleSort('date')}>WHEN (LOCAL){sortColumn === 'date' ? (sortAsc ? ' ▲' : ' ▼') : ''}</th>
                <th class="col-pair sortable" class:sort-active={sortColumn === 'pair'} on:click={() => toggleSort('pair')}>PAIR{sortColumn === 'pair' ? (sortAsc ? ' ▲' : ' ▼') : ''}</th>
                <th class="col-tx">TX</th>
                <th class="col-usd right sortable" class:sort-active={sortColumn === 'usd'} on:click={() => toggleSort('usd')}>USD{sortColumn === 'usd' ? (sortAsc ? ' ▲' : ' ▼') : ''}</th>
                <th class="col-subs right sortable" class:sort-active={sortColumn === 'subs'} on:click={() => toggleSort('subs')}>SUBS{sortColumn === 'subs' ? (sortAsc ? ' ▲' : ' ▼') : ''}</th>
                <th class="col-blocks right sortable" class:sort-active={sortColumn === 'blocks'} on:click={() => toggleSort('blocks')}>BLOCKS{sortColumn === 'blocks' ? (sortAsc ? ' ▲' : ' ▼') : ''}</th>
                <th class="col-saved right sortable" class:sort-active={sortColumn === 'timeSaved'} on:click={() => toggleSort('timeSaved')}>TIME SAVED{sortColumn === 'timeSaved' ? (sortAsc ? ' ▲' : ' ▼') : ''}</th>
                <th class="col-pct right sortable" class:sort-active={sortColumn === 'pctFaster'} on:click={() => toggleSort('pctFaster')}>% FASTER{sortColumn === 'pctFaster' ? (sortAsc ? ' ▲' : ' ▼') : ''}</th>
              </tr>
            </thead>
            <tbody>
              {#each pagedSwaps as row}
                {@const pct = swapPctFaster(row)}
                {@const saved = swapTimeSaved(row)}
                <tr>
                  <td class="col-when mono">{formatDateTime(row.action_date)}</td>
                  <td class="col-pair">{shortPair(row)}</td>
                  <td class="col-tx"><a href={getTxUrl(row.tx_id)} target="_blank" rel="noreferrer">{row.tx_id.slice(0, 10)}...{row.tx_id.slice(-8)}</a></td>
                  <td class="col-usd mono right accent">{formatUSD(swapVolumeUsd(row))}</td>
                  <td class="col-subs mono right">{row.streaming_count}</td>
                  <td class="col-blocks mono right">{row.blocks_used || '-'}</td>
                  <td class="col-saved mono right">{#if saved > 0}<span class="amber">{formatTimeSaved(saved)}</span>{:else}<span class="dim">--</span>{/if}</td>
                  <td class="col-pct mono right">{#if pct > 0}<span class="amber">{pct}%</span>{:else}<span class="dim">--</span>{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <!-- Pagination -->
        {#if totalPages > 1}
          <div class="pagination">
            <button class="page-btn" disabled={currentPage <= 1} on:click={() => goToPage(currentPage - 1)}>Prev</button>
            {#each Array(totalPages) as _, i}
              {#if totalPages <= 7 || i === 0 || i === totalPages - 1 || Math.abs(i + 1 - currentPage) <= 1}
                <button class="page-btn" class:page-active={currentPage === i + 1} on:click={() => goToPage(i + 1)}>{i + 1}</button>
              {:else if i === 1 && currentPage > 3}
                <span class="page-dots">...</span>
              {:else if i === totalPages - 2 && currentPage < totalPages - 2}
                <span class="page-dots">...</span>
              {/if}
            {/each}
            <button class="page-btn" disabled={currentPage >= totalPages} on:click={() => goToPage(currentPage + 1)}>Next</button>
          </div>
        {/if}
      {/if}
    </section>

  {:else if activeTab === 'distributions'}
    <section class="data-section">
      <div class="section-head">
        <h3>SUB SWAPS DISTRIBUTION</h3>
        <span class="section-sub">All recorded rapid swaps</span>
      </div>
      {#if !hasDistributionData}
        <div class="empty">No swap data available.</div>
      {:else}
        <div class="chart-grid">
          <div class="chart-card">
            <div class="chart-title">Sub Swaps Distribution by Swap Volume</div>
            <div class="chart-container"><canvas id="chart-subs-volume"></canvas></div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Sub Swaps Distribution by TX Count</div>
            <div class="chart-container"><canvas id="chart-subs-count"></canvas></div>
          </div>
        </div>
      {/if}
    </section>

    <section class="data-section">
      <div class="section-head">
        <h3>TIME SAVED DISTRIBUTION</h3>
      </div>
      {#if hasDistributionData}
        <div class="chart-grid chart-grid-single">
          <div class="chart-card">
            <div class="chart-title">Time Saved Distribution</div>
            <div class="chart-container"><canvas id="chart-time-dist"></canvas></div>
          </div>
        </div>
      {/if}
    </section>

    <section class="data-section">
      <div class="section-head">
        <h3>RAPID SWAPS BY AFFILIATE</h3>
      </div>
      {#if distributions.affCountLabels?.length}
        <div class="chart-grid">
          <div class="chart-card">
            <div class="chart-title">Rapid Swap Count by Affiliate</div>
            <div class="chart-container chart-tall"><canvas id="chart-aff-count"></canvas></div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Rapid Swap Volume by Affiliate</div>
            <div class="chart-container chart-tall"><canvas id="chart-aff-volume"></canvas></div>
          </div>
        </div>
      {:else}
        <div class="empty">No affiliate data available.</div>
      {/if}
    </section>

  {:else if activeTab === 'paths'}
    <section class="data-section">
      <div class="section-head">
        <h3>SWAP PATH FLOWS</h3>
        <span class="section-sub">All recorded rapid swaps</span>
      </div>
      {#if !hasPathData}
        <div class="empty">No swap data available.</div>
      {:else}
        <div class="chart-grid chart-grid-single">
          <div class="chart-card">
            <div class="chart-title">Volume Flow by Asset (Sankey)</div>
            <div class="chart-container chart-sankey"><canvas id="chart-sankey"></canvas></div>
          </div>
        </div>
      {/if}
    </section>

    <section class="data-section">
      <div class="section-head">
        <h3>SWAP PATH ANALYSIS</h3>
      </div>
      {#if hasPathData}
        <div class="chart-grid">
          <div class="chart-card">
            <div class="chart-title">Top 10 Swap Paths by Volume</div>
            <div class="chart-container chart-tall"><canvas id="chart-paths-volume"></canvas></div>
          </div>
          <div class="chart-card">
            <div class="chart-title">Average Time Saved by Swap Path</div>
            <div class="chart-container chart-tall"><canvas id="chart-paths-time"></canvas></div>
          </div>
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap');

  .rs {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0;
    font-family: 'DM Sans', -apple-system, sans-serif;
    color: var(--term-text-body, #d2d2d2);
  }

  /* ---- STATUS BAR ---- */
  .status-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 16px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--term-text-3, #a3a3a3);
    border-bottom: 1px solid #1a1a1a;
    background: #0a0a0a;
  }

  .status-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #333;
    margin-right: 6px;
    vertical-align: middle;
  }

  .status-dot.ok {
    background: #00cc66;
    box-shadow: 0 0 6px #00cc6644;
  }

  .status-dot.err {
    background: #cc3333;
    box-shadow: 0 0 6px #cc333344;
  }

  .sep {
    color: var(--term-text-7, #787878);
    margin: 0 6px;
  }

  .warn-text {
    color: #b8860b;
  }

  .status-right {
    color: var(--term-text-4, #949494);
    display: flex;
    align-items: center;
    gap: 0;
  }

  .ws-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .ws-dot {
    display: inline-block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #333;
  }

  .ws-ok .ws-dot {
    background: #00cc66;
    box-shadow: 0 0 4px #00cc6644;
    animation: pulse-dot 2s infinite;
  }

  .ws-ok {
    color: #00cc66;
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .source-banner {
    padding: 12px 16px;
    border-bottom: 1px solid #2a220c;
    background: #120f08;
    font-family: 'JetBrains Mono', monospace;
  }

  .source-banner-warn {
    border-color: #3a2d0a;
    background: linear-gradient(90deg, rgba(212, 160, 23, 0.12), rgba(13, 13, 13, 0.96));
  }

  .source-banner-err {
    border-color: #3a1111;
    background: linear-gradient(90deg, rgba(204, 51, 51, 0.14), rgba(13, 13, 13, 0.96));
  }

  .source-banner-title {
    color: #d4a017;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    margin-bottom: 4px;
  }

  .source-banner-err .source-banner-title {
    color: #cc4444;
  }

  .source-banner-body {
    color: var(--term-text-3, #a3a3a3);
    font-size: 13px;
    line-height: 1.5;
  }

  /* ---- STICKY HEADER ---- */
  .sticky-header {
    position: sticky;
    top: 36px; /* below the fixed site navbar */
    z-index: 10;
    background: #0d0d0d;
  }

  /* ---- METRICS ---- */
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    border-bottom: 1px solid #1a1a1a;
    background: #0d0d0d;
  }

  .metric {
    padding: 20px 16px;
    border-right: 1px solid #1a1a1a;
    text-align: center;
  }

  .metric:last-child {
    border-right: none;
  }

  .metric-val {
    font-family: 'JetBrains Mono', monospace;
    font-size: 26px;
    font-weight: 700;
    color: var(--term-text-body, #e8e8e8);
    letter-spacing: -0.02em;
    line-height: 1;
    margin-bottom: 8px;
  }

  .metric-val.accent {
    color: #00cc66;
  }

  .metric-val.amber {
    color: #d4a017;
  }

  .metric-key {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: var(--term-text-3, #a3a3a3);
    text-transform: uppercase;
  }

  .metric-sub {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--term-text-4, #949494);
    margin-top: 4px;
  }

  .metric-largest {
    border-right: none;
  }

  .metric-stats {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--term-text-3, #a3a3a3);
    margin-top: 4px;
    display: flex;
    gap: 0;
    justify-content: center;
    flex-wrap: wrap;
  }

  /* ---- TAB BAR ---- */
  .tab-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #0a0a0a;
    border-bottom: 1px solid #1a1a1a;
    padding: 0 16px;
  }

  .tab-btns {
    display: flex;
    gap: 0;
  }

  .date-range {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .date-input {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    background: #1a1a1a;
    border: 1px solid #333;
    color: var(--term-text-3, #c8c8c8);
    padding: 4px 8px;
    border-radius: 4px;
  }

  .date-input:focus {
    outline: none;
    border-color: #00cc66;
    color: #ddd;
  }

  .date-sep {
    color: var(--term-text-4, #949494);
    font-size: 11px;
  }

  .tab-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--term-text-4, #949494);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 10px 16px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  .tab-btn:hover {
    color: var(--term-text-4, #bcbcbc);
  }

  .tab-active {
    color: #00cc66;
    border-bottom-color: #00cc66;
  }

  /* ---- CHARTS ---- */
  .chart-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: #1a1a1a;
  }

  .chart-grid-single {
    grid-template-columns: 1fr;
  }

  .chart-card {
    background: #0d0d0d;
    padding: 16px;
    min-width: 0;
  }

  .chart-title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--term-text-3, #a3a3a3);
    text-transform: uppercase;
    margin-bottom: 12px;
  }

  .chart-container {
    position: relative;
    height: 220px;
    width: 100%;
    overflow: hidden;
  }

  .chart-tall {
    height: 320px;
  }

  .chart-sankey {
    height: 400px;
  }

  /* ---- TABLE FILTERS ---- */
  .table-filters {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    background: #0a0a0a;
    border-bottom: 1px solid #141414;
    flex-wrap: wrap;
    align-items: center;
  }

  .filter-input {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 6px 10px;
    background: #111;
    border: 1px solid #222;
    color: var(--term-text-2, #d8d8d8);
    border-radius: 3px;
    outline: none;
    transition: border-color 0.15s;
    min-width: 140px;
  }

  .filter-input:focus {
    border-color: #00cc66;
  }

  .filter-num {
    width: 130px;
    min-width: 100px;
  }

  .filter-input::placeholder {
    color: var(--term-text-4, #949494);
  }

  .filter-clear {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 6px 12px;
    background: #1a1a1a;
    border: 1px solid #333;
    color: var(--term-text-3, #a3a3a3);
    border-radius: 3px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .filter-clear:hover {
    background: #222;
    color: var(--term-text-2, #d8d8d8);
  }

  /* ---- DATA SECTIONS ---- */
  .data-section {
    border-bottom: 1px solid #1a1a1a;
  }

  .section-head {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 14px 16px 10px;
    background: #0a0a0a;
    border-bottom: 1px solid #141414;
  }

  .section-head h3 {
    margin: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--term-text-3, #a3a3a3);
  }

  .section-sub {
    font-size: 11px;
    color: var(--term-text-4, #949494);
  }

  /* ---- TABLES ---- */
  .table-wrap {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 700px;
  }

  th {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--term-text-3, #a3a3a3);
    text-align: left;
    padding: 8px 16px;
    border-bottom: 1px solid #1a1a1a;
    background: #0a0a0a;
    position: sticky;
    top: 0;
  }

  th.right {
    text-align: right;
  }

  th.sortable {
    cursor: pointer;
    user-select: none;
    transition: color 0.15s;
  }

  th.sortable:hover {
    color: #00cc66;
  }

  th.sort-active {
    color: #00cc66;
  }

  td {
    padding: 10px 16px;
    font-size: 13px;
    border-bottom: 1px solid #111;
    color: var(--term-text-3, #c8c8c8);
    vertical-align: middle;
  }

  .mono {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }

  .dim {
    color: var(--term-text-4, #949494);
  }

  .right {
    text-align: right;
  }

  .accent {
    color: #00cc66;
  }

  .amber {
    color: #d4a017;
  }

  tbody tr {
    background: #0d0d0d;
    transition: background 0.1s;
  }

  tbody tr:hover {
    background: #141414;
  }

  a {
    color: #5588cc;
    text-decoration: none;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }

  a:hover {
    color: #77aaee;
    text-decoration: underline;
  }

  /* ---- PAGINATION ---- */
  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 12px 16px;
    background: #0a0a0a;
  }

  .page-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 4px 10px;
    background: #111;
    border: 1px solid #222;
    color: var(--term-text-3, #a3a3a3);
    border-radius: 3px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .page-btn:hover:not(:disabled) {
    background: #1a1a1a;
    color: var(--term-text-2, #d8d8d8);
    border-color: #333;
  }

  .page-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .page-active {
    background: #00cc66;
    border-color: #00cc66;
    color: #000;
    font-weight: 700;
  }

  .page-active:hover {
    background: #00cc66 !important;
    color: #000 !important;
    border-color: #00cc66 !important;
  }

  .page-dots {
    color: var(--term-text-4, #949494);
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 0 4px;
  }

  /* ---- EMPTY / ERROR ---- */
  .empty {
    padding: 24px 16px;
    color: var(--term-text-3, #a3a3a3);
    font-size: 13px;
    font-family: 'JetBrains Mono', monospace;
  }

  .err-text {
    color: #cc4444;
  }

  /* ---- RESPONSIVE ---- */
  @media (max-width: 900px) {
    .metrics {
      grid-template-columns: repeat(3, 1fr);
    }

    .metric:nth-child(n+4) {
      border-top: 1px solid #1a1a1a;
    }

    .chart-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 600px) {
    .metrics {
      grid-template-columns: repeat(2, 1fr);
    }

    .metric {
      padding: 14px 12px;
    }

    .metric-val {
      font-size: 20px;
    }

    .status-bar {
      font-size: 11px;
      flex-wrap: wrap;
      gap: 4px;
    }

    th, td {
      padding: 8px 10px;
    }

    .tab-btn {
      padding: 8px 10px;
      font-size: 11px;
    }

    .table-filters {
      flex-direction: column;
    }

    .filter-input, .filter-num {
      width: 100%;
      min-width: unset;
    }
  }
</style>
