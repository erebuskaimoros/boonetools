<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import Chart from 'chart.js/auto';
  import { fetchJSONWithFallback, MIDGARD_ENDPOINTS } from '$lib/utils/api';
  import {
    buildAffiliateMidgardSeries,
    buildDynamicFeeModel,
    buildEpochChartSeries,
    computeEpochTiming
  } from '$lib/dynamic-fees/model.js';

  const CHART = {
    green: '#00cc66',
    greenSoft: 'rgba(0, 204, 102, 0.18)',
    amber: '#d4a017',
    amberSoft: 'rgba(212, 160, 23, 0.18)',
    blue: '#5588cc',
    grid: '#1a1a1a',
    text: '#777'
  };
  const RPC_WS_URLS = [
    'wss://gateway.liquify.com/chain/thorchain_rpc/websocket',
    'wss://rpc.thorchain.network/websocket'
  ];
  const RECONNECT_BASE_MS = 1_000;
  const RECONNECT_MAX_MS = 30_000;
  const EPOCH_REFRESH_DEBOUNCE_MS = 2_500;
  const AFFILIATE_TIMEFRAMES = [
    { id: '7d', label: '1W', count: 7 },
    { id: '30d', label: '1M', count: 30 },
    { id: '90d', label: '3M', count: 90 },
    { id: '180d', label: '6M', count: 180 },
    { id: '365d', label: '1Y', count: 365 }
  ];

  let model = null;
  let error = null;
  let loading = true;
  let refreshing = false;
  let lastRefresh = null;
  let selectedId = '';
  let search = '';
  let stateFilter = 'all';
  let activeDashboardTab = 'pair';
  let selectedAffiliateId = '';
  let affiliateTimeframe = '90d';
  let sortField = 'currentFeesUsd';
  let sortDir = 'desc';
  let chartCanvas;
  let chartInstance = null;
  let renderedChartKey = '';
  let affiliateChartCanvas;
  let affiliateChartInstance = null;
  let renderedAffiliateChartKey = '';
  let affiliateHistoryCache = {};
  let affiliateHistoryLoading = false;
  let affiliateHistoryError = null;
  let requestedAffiliateHistoryKey = '';
  let activeAffiliateHistoryKey = '';
  let detailCache = {};
  let rpcWs = null;
  let rpcConnected = false;
  let rpcStatus = 'idle';
  let rpcLastBlock = 0;
  let rpcReconnectAttempt = 0;
  let rpcUrlIndex = 0;
  let rpcReconnectTimer = null;
  let epochRefreshTimer = null;
  let shuttingDownRpc = false;

  $: records = model?.records || [];
  $: currentEntries = model?.currentEntries || [];
  $: affiliates = model?.affiliates || [];
  $: affiliateTimeframeOption =
    AFFILIATE_TIMEFRAMES.find((option) => option.id === affiliateTimeframe) ||
    AFFILIATE_TIMEFRAMES[2];
  $: if (affiliates.length && (!selectedAffiliateId || !affiliates.some((entry) => entry.id === selectedAffiliateId))) {
    selectedAffiliateId = affiliates[0].id;
  }
  $: selectedAffiliate =
    affiliates.find((entry) => entry.id === selectedAffiliateId) ||
    affiliates[0] ||
    null;
  $: affiliateHistoryKey = selectedAffiliate
    ? `${selectedAffiliate.id}:${affiliateTimeframeOption.id}`
    : '';
  $: affiliateHistory = affiliateHistoryKey ? affiliateHistoryCache[affiliateHistoryKey] || null : null;
  $: filteredRecords = sortRecords(filterRecords(records, search, stateFilter), sortField, sortDir);
  $: selectedRecord =
    records.find((record) => record.id === selectedId) ||
    filteredRecords[0] ||
    records[0] ||
    null;
  $: emptyState = model && records.length === 0 && currentEntries.length === 0;
  $: socketBlockHeight = rpcLastBlock || model?.config.blockHeight || 0;
  $: socketLabel = rpcConnected
    ? 'live blocks'
    : rpcStatus === 'connecting'
      ? 'connecting'
      : rpcStatus === 'closed' || rpcStatus === 'error'
        ? 'reconnecting'
        : 'block socket';
  $: socketTitle = rpcConnected
    ? `THORChain RPC WebSocket connected${socketBlockHeight ? `; latest block ${formatNumber(socketBlockHeight, 0)}` : ''}`
    : rpcStatus === 'connecting'
      ? `Connecting to THORChain RPC WebSocket${socketBlockHeight ? `; latest block ${formatNumber(socketBlockHeight, 0)}` : ''}`
      : rpcStatus === 'closed' || rpcStatus === 'error'
        ? `THORChain RPC WebSocket reconnecting; countdown is using the last known block${socketBlockHeight ? `; latest block ${formatNumber(socketBlockHeight, 0)}` : ''}`
        : `THORChain RPC WebSocket not connected${socketBlockHeight ? `; latest block ${formatNumber(socketBlockHeight, 0)}` : ''}`;
  $: chartKey = selectedRecord
    ? `${selectedRecord.id}:${selectedRecord.history.length}:${selectedRecord.dynamicBps}:${selectedRecord.currentFeesUsd}`
    : 'empty';
  $: affiliateChartKey = affiliateHistory
    ? `${affiliateHistoryKey}:${affiliateHistory.points.length}:${affiliateHistory.totalVolumeUsd}:${affiliateHistory.totalFeesUsd}`
    : `${affiliateHistoryKey}:empty:${affiliateHistoryLoading}`;
  $: if (chartCanvas && chartKey !== renderedChartKey) {
    renderedChartKey = chartKey;
    tick().then(renderChart);
  }
  $: if (
    activeDashboardTab === 'affiliate' &&
    selectedAffiliate &&
    affiliateHistoryKey &&
    affiliateHistoryKey !== requestedAffiliateHistoryKey
  ) {
    requestedAffiliateHistoryKey = affiliateHistoryKey;
    if (!affiliateHistoryCache[affiliateHistoryKey]) {
      loadAffiliateHistory(selectedAffiliate, affiliateTimeframeOption, affiliateHistoryKey);
    }
  }
  $: if (affiliateChartCanvas && affiliateChartKey !== renderedAffiliateChartKey) {
    renderedAffiliateChartKey = affiliateChartKey;
    tick().then(renderAffiliateChart);
  }

  onMount(() => {
    loadData();
    connectRpcWs();
  });

  onDestroy(() => {
    chartInstance?.destroy();
    affiliateChartInstance?.destroy();
    disconnectRpcWs();
    clearTimeout(epochRefreshTimer);
  });

  async function loadData() {
    const hasModel = Boolean(model);
    loading = !hasModel;
    refreshing = hasModel;
    error = null;

    try {
      const [mimir, recordsResponse, currentResponse, lastblock] = await Promise.all([
        fetchJSONWithFallback('/thorchain/mimir'),
        fetchJSONWithFallback('/thorchain/dynamic_l1_fees'),
        fetchJSONWithFallback('/thorchain/dynamic_l1_fees_current'),
        fetchJSONWithFallback('/thorchain/lastblock')
      ]);

      const thornames = Array.from(
        new Set((recordsResponse?.entries || []).map((entry) => entry.thorname).filter(Boolean))
      );
      const detailsByThorname = {};

      await Promise.all(
        thornames.map(async (thorname) => {
          try {
            const detail = await getThornameDetail(thorname);
            if (detail) {
              detailsByThorname[thorname] = detail;
              detailsByThorname[String(thorname).toLowerCase()] = detail;
              detailsByThorname[String(thorname).toUpperCase()] = detail;
            }
          } catch (detailError) {
            console.warn(`dynamic fee detail fetch failed for ${thorname}`, detailError);
          }
        })
      );

      model = buildDynamicFeeModel({
        mimir,
        recordsResponse,
        currentResponse,
        detailsByThorname,
        lastblock
      });

      const loadedHeight = model.config.blockHeight;
      if (rpcLastBlock > loadedHeight) {
        updateModelBlockHeight(rpcLastBlock, { refreshOnEpochChange: false });
      } else if (loadedHeight > rpcLastBlock) {
        rpcLastBlock = loadedHeight;
      }

      if (!selectedId || !model.records.some((record) => record.id === selectedId)) {
        selectedId = model.records[0]?.id || '';
      }

      if (!selectedAffiliateId || !model.affiliates.some((affiliate) => affiliate.id === selectedAffiliateId)) {
        selectedAffiliateId = model.affiliates[0]?.id || '';
      }

      lastRefresh = new Date();
    } catch (err) {
      console.error('dynamic fee dashboard load failed', err);
      error = err?.message || 'failed to load dynamic fee state';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function getThornameDetail(thorname) {
    const key = String(thorname).toLowerCase();
    if (detailCache[key]) return detailCache[key];
    const detail = await fetchJSONWithFallback(`/thorchain/dynamic_l1_fees/${encodeURIComponent(thorname)}`);
    detailCache = { ...detailCache, [key]: detail };
    return detail;
  }

  async function loadAffiliateHistory(affiliate, timeframe, requestKey) {
    if (!affiliate?.thorname || !timeframe?.count) return;

    affiliateHistoryLoading = true;
    affiliateHistoryError = null;
    activeAffiliateHistoryKey = requestKey;

    const params = new URLSearchParams({
      thorname: affiliate.thorname,
      interval: 'day',
      count: String(timeframe.count)
    });

    try {
      const [statsRows, earningsRows] = await Promise.all([
        fetchJSONWithFallback(`/v2/history/affiliate/stats?${params.toString()}`, {}, MIDGARD_ENDPOINTS),
        fetchJSONWithFallback(`/v2/history/affiliate/earnings?${params.toString()}`, {}, MIDGARD_ENDPOINTS)
      ]);

      const series = buildAffiliateMidgardSeries(statsRows, earningsRows, affiliate.thorname);
      affiliateHistoryCache = {
        ...affiliateHistoryCache,
        [requestKey]: series
      };
    } catch (err) {
      if (activeAffiliateHistoryKey === requestKey) {
        affiliateHistoryError = err?.message || 'failed to load affiliate history';
      }
    } finally {
      if (activeAffiliateHistoryKey === requestKey) {
        affiliateHistoryLoading = false;
      }
    }
  }

  function connectRpcWs() {
    if (typeof WebSocket === 'undefined') return;

    clearTimeout(rpcReconnectTimer);
    shuttingDownRpc = false;
    rpcStatus = 'connecting';

    const ws = new WebSocket(RPC_WS_URLS[rpcUrlIndex % RPC_WS_URLS.length]);
    rpcWs = ws;

    ws.onopen = () => {
      if (rpcWs !== ws) return;
      rpcConnected = true;
      rpcStatus = 'open';
      rpcReconnectAttempt = 0;
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        id: 1,
        params: { query: "tm.event='NewBlock'" }
      }));
    };

    ws.onmessage = (event) => {
      if (rpcWs !== ws) return;
      handleRpcMessage(event.data);
    };

    ws.onerror = () => {
      if (rpcWs !== ws) return;
      rpcConnected = false;
      rpcStatus = 'error';
      ws.close();
    };

    ws.onclose = () => {
      if (rpcWs !== ws) return;
      rpcWs = null;
      rpcConnected = false;
      rpcStatus = 'closed';
      scheduleRpcReconnect();
    };
  }

  function disconnectRpcWs() {
    shuttingDownRpc = true;
    clearTimeout(rpcReconnectTimer);
    rpcReconnectTimer = null;
    if (rpcWs) {
      rpcWs.onclose = null;
      rpcWs.close();
      rpcWs = null;
    }
    rpcConnected = false;
  }

  function scheduleRpcReconnect() {
    if (shuttingDownRpc) return;
    clearTimeout(rpcReconnectTimer);
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** rpcReconnectAttempt, RECONNECT_MAX_MS);
    rpcReconnectAttempt += 1;
    rpcUrlIndex = (rpcUrlIndex + 1) % RPC_WS_URLS.length;
    rpcReconnectTimer = setTimeout(connectRpcWs, delay);
  }

  function handleRpcMessage(raw) {
    try {
      const message = JSON.parse(raw);
      const height = message.result?.data?.value?.block?.header?.height;
      if (height) applyLiveBlockHeight(height);
    } catch (_) {}
  }

  function applyLiveBlockHeight(value) {
    const blockHeight = Number(value);
    if (!Number.isFinite(blockHeight) || blockHeight <= 0 || blockHeight <= rpcLastBlock) return;
    rpcLastBlock = blockHeight;
    updateModelBlockHeight(blockHeight);
  }

  function updateModelBlockHeight(blockHeight, { refreshOnEpochChange = true } = {}) {
    if (!model?.config?.epochBlocks) return;

    const previousEpoch = model.config.currentEpoch;
    const epochTiming = computeEpochTiming({
      epochBlocks: model.config.epochBlocks,
      blockHeight
    });

    model = {
      ...model,
      config: {
        ...model.config,
        ...epochTiming
      }
    };

    if (refreshOnEpochChange && previousEpoch && epochTiming.currentEpoch > previousEpoch) {
      scheduleEpochRefresh();
    }
  }

  function scheduleEpochRefresh() {
    clearTimeout(epochRefreshTimer);
    epochRefreshTimer = setTimeout(() => {
      if (!loading && !refreshing) loadData();
    }, EPOCH_REFRESH_DEBOUNCE_MS);
  }

  function filterRecords(source, query, state) {
    const normalized = query.trim().toLowerCase();
    return source.filter((record) => {
      const matchesState = state === 'all' || record.stateKind === state;
      const matchesSearch =
        !normalized ||
        record.thorname.toLowerCase().includes(normalized) ||
        record.pair.toLowerCase().includes(normalized);
      return matchesState && matchesSearch;
    });
  }

  function sortRecords(source, field, direction) {
    const factor = direction === 'asc' ? 1 : -1;
    return [...source].sort((a, b) => {
      if (field === 'thorname') return factor * a.thorname.localeCompare(b.thorname);
      if (field === 'pair') return factor * a.pair.localeCompare(b.pair);
      return factor * ((Number(a[field]) || 0) - (Number(b[field]) || 0));
    });
  }

  function toggleSort(field) {
    if (sortField === field) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      return;
    }
    sortField = field;
    sortDir = field === 'thorname' || field === 'pair' ? 'asc' : 'desc';
  }

  function selectRecord(record) {
    selectedId = record.id;
    tick().then(renderChart);
  }

  function selectAffiliate(affiliate) {
    selectedAffiliateId = affiliate.id;
    tick().then(renderAffiliateChart);
  }

  function selectDashboardTab(tab) {
    activeDashboardTab = tab;
    if (tab === 'pair') tick().then(renderChart);
    if (tab === 'affiliate') tick().then(renderAffiliateChart);
  }

  function renderChart() {
    chartInstance?.destroy();
    chartInstance = null;

    if (!chartCanvas || !selectedRecord || selectedRecord.history.length === 0) return;

    const { labels, fees, bps } = buildEpochChartSeries(selectedRecord, model.config.currentEpoch);

    chartInstance = new Chart(chartCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            label: 'fees',
            data: fees,
            backgroundColor: CHART.greenSoft,
            borderColor: CHART.green,
            borderWidth: 1,
            yAxisID: 'y'
          },
          {
            type: 'line',
            label: 'bps',
            data: bps,
            borderColor: CHART.amber,
            backgroundColor: CHART.amberSoft,
            pointBackgroundColor: CHART.amber,
            pointRadius: 3,
            borderWidth: 2,
            tension: 0.2,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 220 },
        plugins: {
          legend: {
            display: true,
            labels: {
              color: CHART.text,
              boxWidth: 12,
              font: { family: 'JetBrains Mono', size: 10 }
            }
          },
          tooltip: {
            backgroundColor: '#1a1a1a',
            titleColor: '#d8d8d8',
            bodyColor: '#aaa',
            borderColor: '#333',
            borderWidth: 1,
            titleFont: { family: 'JetBrains Mono', size: 11 },
            bodyFont: { family: 'JetBrains Mono', size: 11 },
            callbacks: {
              label: (ctx) => {
                if (ctx.dataset.label === 'bps') return `bps: ${formatBps(ctx.parsed.y)}`;
                return `fees: ${formatUsd(ctx.parsed.y)}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: CHART.grid },
            ticks: { color: CHART.text, font: { family: 'JetBrains Mono', size: 10 } }
          },
          y: {
            beginAtZero: true,
            position: 'left',
            grid: { color: CHART.grid },
            ticks: {
              color: CHART.text,
              font: { family: 'JetBrains Mono', size: 10 },
              callback: (value) => formatUsdCompact(value)
            }
          },
          y1: {
            beginAtZero: true,
            position: 'right',
            grid: { drawOnChartArea: false, color: CHART.grid },
            ticks: {
              color: CHART.text,
              font: { family: 'JetBrains Mono', size: 10 },
              callback: (value) => `${value} bps`
            }
          }
        }
      }
    });
  }

  function renderAffiliateChart() {
    affiliateChartInstance?.destroy();
    affiliateChartInstance = null;

    if (!affiliateChartCanvas || !affiliateHistory?.points?.length) return;

    affiliateChartInstance = new Chart(affiliateChartCanvas, {
      type: 'bar',
      data: {
        labels: affiliateHistory.labels,
        datasets: [
          {
            type: 'bar',
            label: 'volume',
            data: affiliateHistory.volume,
            backgroundColor: CHART.greenSoft,
            borderColor: CHART.green,
            borderWidth: 1,
            yAxisID: 'yVolume'
          },
          {
            type: 'line',
            label: 'fees',
            data: affiliateHistory.fees,
            borderColor: CHART.amber,
            backgroundColor: CHART.amberSoft,
            pointBackgroundColor: CHART.amber,
            pointRadius: 2,
            borderWidth: 2,
            tension: 0.25,
            yAxisID: 'yFees'
          },
          {
            type: 'line',
            label: 'fees / volume',
            data: affiliateHistory.rateBps,
            borderColor: CHART.blue,
            backgroundColor: 'rgba(85, 136, 204, 0.12)',
            pointBackgroundColor: CHART.blue,
            pointRadius: 2,
            borderWidth: 2,
            tension: 0.25,
            spanGaps: true,
            yAxisID: 'yRate'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 220 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            labels: {
              color: CHART.text,
              boxWidth: 12,
              font: { family: 'JetBrains Mono', size: 10 }
            }
          },
          tooltip: {
            backgroundColor: '#1a1a1a',
            titleColor: '#d8d8d8',
            bodyColor: '#aaa',
            borderColor: '#333',
            borderWidth: 1,
            titleFont: { family: 'JetBrains Mono', size: 11 },
            bodyFont: { family: 'JetBrains Mono', size: 11 },
            callbacks: {
              label: (ctx) => {
                if (ctx.dataset.label === 'fees / volume') {
                  return `fees / volume: ${formatRateBps(ctx.parsed.y)}`;
                }
                return `${ctx.dataset.label}: ${formatUsd(ctx.parsed.y)}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: CHART.grid },
            ticks: {
              color: CHART.text,
              maxRotation: 0,
              autoSkip: true,
              font: { family: 'JetBrains Mono', size: 10 }
            }
          },
          yVolume: {
            beginAtZero: true,
            position: 'left',
            grid: { color: CHART.grid },
            ticks: {
              color: CHART.text,
              font: { family: 'JetBrains Mono', size: 10 },
              callback: (value) => formatUsdCompact(value)
            }
          },
          yFees: {
            beginAtZero: true,
            position: 'right',
            grid: { drawOnChartArea: false },
            ticks: {
              color: CHART.amber,
              font: { family: 'JetBrains Mono', size: 10 },
              callback: (value) => formatUsdCompact(value)
            }
          },
          yRate: {
            beginAtZero: true,
            position: 'right',
            grid: { drawOnChartArea: false },
            ticks: {
              color: CHART.blue,
              font: { family: 'JetBrains Mono', size: 10 },
              callback: (value) => `${formatNumber(value, Number(value) < 10 && Number(value) !== 0 ? 2 : 0)} bps`
            }
          }
        }
      }
    });
  }

  function statusMessage() {
    if (!model) return 'loading';
    if (model.config.adr26 !== 1) return 'ADR26 not approved';
    if (model.config.enabled !== 1) return 'ADR26 approved; L1 dynamic fee switch is off';
    if (emptyState) return 'ADR26 enabled; waiting for eligible affiliate L1 swap signal';
    return 'ADR26 signal live';
  }

  function configRows() {
    if (!model) return [];
    const config = model.config;
    return [
      ['epoch', `${formatNumber(config.epochBlocks, 0)} blocks`, '~1 day'],
      ['floor', `${formatBps(config.floorBps)}`],
      ['ceiling', `${formatBps(config.ceilingBps)}`],
      ['step', `${formatBps(config.stepBps)}`],
      ['deadband', `${formatPercentBps(config.deadbandBps)} fee swing`],
      ['window', `${config.windowEpochs} epochs`],
      ['static l1', `${formatBps(config.l1SlipMinBps)}`]
    ];
  }

  function formatUsd(value) {
    if (!Number.isFinite(Number(value))) return '$0';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2
    }).format(Number(value));
  }

  function formatUsdCompact(value) {
    const amount = Number(value) || 0;
    if (Math.abs(amount) >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B`;
    if (Math.abs(amount) >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
    if (Math.abs(amount) >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
    return formatUsd(amount);
  }

  function formatNumber(value, digits = 2) {
    const amount = Number(value) || 0;
    return new Intl.NumberFormat('en-US', {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits > 0 && Math.abs(amount) < 10 && amount !== 0 ? 1 : 0
    }).format(amount);
  }

  function formatBps(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
    return `${formatNumber(value, Number(value) < 10 && Number(value) !== 0 ? 2 : 0)} bps`;
  }

  function formatPercentBps(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
    const percent = Number(value) / 100;
    return `${formatNumber(percent, Math.abs(percent) < 10 && percent !== 0 ? 2 : 1)}%`;
  }

  function formatRateBps(value) {
    return value === null || value === undefined ? '--' : formatBps(value);
  }

  function formatTime(date) {
    if (!date) return '--';
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(date);
  }

  function sortMark(field) {
    if (sortField !== field) return '';
    return sortDir === 'asc' ? ' ^' : ' v';
  }

  function movementClass(record) {
    if (!record?.decision) return '';
    return record.decision.movement > 0 ? 'up' : record.decision.movement < 0 ? 'down' : 'hold';
  }
</script>

<section class="terminal">
  <div class="head">
    <div class="head-top">
      <div class="head-left">
        <span class="prompt">$</span>
        <span class="cmd">track</span>
        <span class="arg">adr26 dynamic-l1-fees</span>
      </div>
      <div class="head-right">
        <span class="status" title={statusMessage()}>
          <span
            class="dot"
            class:ok={model?.summary.statusKind === 'ok'}
            class:warn={model?.summary.statusKind === 'warn'}
          ></span>
          {model?.summary.statusLabel || 'loading'}
        </span>
        <span class="sep">|</span>
        <span>{lastRefresh ? `refresh ${formatTime(lastRefresh)}` : 'refresh --'}</span>
        <span class="socket-status" title={socketTitle}>
          <span class="dot" class:ok={rpcConnected} class:warn={!rpcConnected && rpcStatus !== 'idle'}></span>
          {socketLabel}
        </span>
        <button class="refresh" on:click={loadData} disabled={loading || refreshing}>
          <span class="bracket">[</span><span class="key">R</span><span class="bracket">]</span>
          {refreshing ? 'refreshing' : 'refresh'}
        </button>
      </div>
    </div>
    <h1 class="title">ADR26 <span class="arrow">-&gt;</span> Dynamic L1 Fees<span class="cursor">_</span></h1>
    <div class="rule"></div>
  </div>

  {#if error}
    <div class="alerts">
      <div class="alert err"><span class="alert-tag">ERR</span><span>{error}</span></div>
    </div>
  {:else if emptyState}
    <div class="alerts">
      <div class="alert warn"><span class="alert-tag">ARM</span><span>{statusMessage()}</span></div>
    </div>
  {/if}

  <section class="block">
    <div class="block-head">
      <div class="block-title"><span class="title-marker">|</span><h2>Controller</h2></div>
      <div class="block-meta">[epoch {model?.config.currentEpoch || '--'}]</div>
    </div>

    {#if loading}
      <div class="loading-block"><span class="loading-marker">////</span><span>loading chain state</span></div>
    {:else if model}
      <div class="controller-grid">
        <div class="epoch-panel">
          <div class="panel-label">epoch seal</div>
          <div class="panel-value">{model.config.blocksUntilSeal === null ? '--' : `${formatNumber(model.config.blocksUntilSeal, 0)} blocks`}</div>
          <div class="progress-track">
            <span style={`width: ${Math.max(2, Math.min(100, model.config.epochProgress * 100))}%`}></span>
          </div>
          <div class="panel-foot">{rpcConnected ? 'live height' : 'height'} {formatNumber(model.config.blockHeight, 0)}</div>
        </div>

        <div class="config-grid">
          {#each configRows() as row}
            <div class="config-cell">
              <span>{row[0]}</span>
              <strong>{row[1]}</strong>
              {#if row[2]}
                <small>{row[2]}</small>
              {/if}
            </div>
          {/each}
        </div>

        <div class="whitelist-panel">
          <div class="panel-label">whitelist</div>
          {#if model.config.whitelists.length}
            <div class="whitelist-list">
              {#each model.config.whitelists.slice(0, 12) as entry}
                <span class={`pill ${entry.kind}`}>{entry.thorname}<small>{entry.label}</small></span>
              {/each}
            </div>
          {:else}
            <div class="empty-line">no dynamic fee whitelist keys</div>
          {/if}
        </div>
      </div>
    {/if}
  </section>

  <div class="dashboard-tabs" role="tablist" aria-label="Dynamic fee views">
    <button
      type="button"
      role="tab"
      aria-selected={activeDashboardTab === 'pair'}
      class:active={activeDashboardTab === 'pair'}
      on:click={() => selectDashboardTab('pair')}
    >
      Pair
      <small>{records.length}</small>
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={activeDashboardTab === 'affiliate'}
      class:active={activeDashboardTab === 'affiliate'}
      on:click={() => selectDashboardTab('affiliate')}
    >
      Affiliate
      <small>{affiliates.length}</small>
    </button>
  </div>

  {#if activeDashboardTab === 'pair'}
  <div class="split">
    <section class="block chart-block">
      <div class="block-head">
        <div class="block-title"><span class="title-marker">|</span><h2>Selected Pair</h2></div>
        <div class="block-meta">[{selectedRecord?.pairLabel || 'none'}]</div>
      </div>

      {#if selectedRecord}
        <div class="selected-strip">
          <div>
            <span>thorname</span>
            <strong>{selectedRecord.thorname}</strong>
          </div>
          <div>
            <span>dynamic</span>
            <strong>{formatBps(selectedRecord.dynamicBps)}</strong>
          </div>
          <div>
            <span>signal</span>
            <strong>{formatUsdCompact(selectedRecord.currentFeesUsd)}</strong>
          </div>
          <div>
            <span>decision</span>
            <strong class={movementClass(selectedRecord)}>{selectedRecord.decision.reason.replaceAll('_', ' ')}</strong>
          </div>
        </div>
      {/if}

      <div class="chart-frame">
        {#if selectedRecord?.history?.length}
          <canvas bind:this={chartCanvas}></canvas>
        {:else}
          <div class="loading-block">
            <span class="loading-marker">----</span>
            <span>{selectedRecord ? 'awaiting sealed epoch history' : 'no pair selected'}</span>
          </div>
        {/if}
      </div>
    </section>

    <section class="block">
      <div class="block-head">
        <div class="block-title"><span class="title-marker">|</span><h2>Pair State</h2></div>
        <div class="block-meta">[{selectedRecord?.stateLabel || '--'}]</div>
      </div>

      {#if selectedRecord}
        <div class="state-grid">
          <div class="state-row">
            <span>live volume</span>
            <strong>{formatUsdCompact(selectedRecord.currentVolumeUsd)}</strong>
          </div>
          <div class="state-row">
            <span>live rate</span>
            <strong>{formatRateBps(selectedRecord.currentRateBps)}</strong>
          </div>
          <div class="state-row">
            <span>sealed fees</span>
            <strong>{formatUsdCompact(selectedRecord.historyFeesUsd)}</strong>
          </div>
          <div class="state-row">
            <span>sealed rate</span>
            <strong>{formatRateBps(selectedRecord.historyRateBps)}</strong>
          </div>
          <div class="state-row">
            <span>last active</span>
            <strong>E{selectedRecord.lastActiveEpoch || '--'}</strong>
          </div>
          <div class="state-row">
            <span>stale</span>
            <strong>{formatNumber(selectedRecord.staleEpochs, 0)} epochs</strong>
          </div>
        </div>

        <div class="decision-box">
          <div class="decision-head">
            <span>last controller move</span>
            <strong class={movementClass(selectedRecord)}>
              {formatBps(selectedRecord.decision.oldBps)} -&gt; {formatBps(selectedRecord.dynamicBps)}
            </strong>
          </div>
          <div class="decision-body">
            <span>fees before</span><strong>{formatUsdCompact(selectedRecord.decision.feesBefore / 1e8)}</strong>
            <span>fees after</span><strong>{formatUsdCompact(selectedRecord.decision.feesAfter / 1e8)}</strong>
            <span>fee delta</span><strong>{formatPercentBps(selectedRecord.decision.deltaPctBps)}</strong>
          </div>
        </div>
      {:else}
        <div class="empty-line">no tracked pair state</div>
      {/if}
    </section>
  </div>

  <section class="block">
    <div class="block-head">
      <div class="block-title"><span class="title-marker">|</span><h2>Pair Registry</h2></div>
      <div class="block-meta">[{filteredRecords.length}/{records.length} rows]</div>
    </div>

    <div class="table-controls">
      <div class="filter-tabs">
        <button class:active={stateFilter === 'all'} on:click={() => (stateFilter = 'all')}>all</button>
        <button class:active={stateFilter === 'active'} on:click={() => (stateFilter = 'active')}>active</button>
        <button class:active={stateFilter === 'monitor'} on:click={() => (stateFilter = 'monitor')}>monitor</button>
        <button class:active={stateFilter === 'inactive'} on:click={() => (stateFilter = 'inactive')}>inactive</button>
      </div>
      <input bind:value={search} placeholder="filter thorname or pair" />
    </div>

    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th on:click={() => toggleSort('thorname')}>thorname{sortMark('thorname')}</th>
            <th on:click={() => toggleSort('pair')}>pair{sortMark('pair')}</th>
            <th>state</th>
            <th on:click={() => toggleSort('dynamicBps')}>dynamic{sortMark('dynamicBps')}</th>
            <th on:click={() => toggleSort('currentFeesUsd')}>live fees{sortMark('currentFeesUsd')}</th>
            <th on:click={() => toggleSort('latestFeesUsd')}>last fees{sortMark('latestFeesUsd')}</th>
            <th>decision</th>
            <th on:click={() => toggleSort('staleEpochs')}>stale{sortMark('staleEpochs')}</th>
          </tr>
        </thead>
        <tbody>
          {#if filteredRecords.length}
            {#each filteredRecords as record}
              <tr
                class:selected={selectedRecord?.id === record.id}
                on:click={() => selectRecord(record)}
                tabindex="0"
                on:keydown={(event) => event.key === 'Enter' && selectRecord(record)}
              >
                <td class="strong">{record.thorname}</td>
                <td class="mono">{record.pairLabel}</td>
                <td><span class={`pill ${record.stateKind}`}>{record.stateLabel}</span></td>
                <td class="accent">{formatBps(record.dynamicBps)}</td>
                <td>{formatUsdCompact(record.currentFeesUsd)}</td>
                <td>{formatUsdCompact(record.latestFeesUsd)}</td>
                <td><span class={`move ${movementClass(record)}`}>{record.decision.reason.replaceAll('_', ' ')}</span></td>
                <td>{formatNumber(record.staleEpochs, 0)}</td>
              </tr>
            {/each}
          {:else}
            <tr><td colspan="8" class="empty-cell">no matching dynamic fee records</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  </section>

  <section class="block">
    <div class="block-head">
      <div class="block-title"><span class="title-marker">|</span><h2>Current Epoch Signal</h2></div>
      <div class="block-meta">[{currentEntries.length} accumulators]</div>
    </div>

    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>thorname</th>
            <th>pair</th>
            <th>state</th>
            <th>dynamic</th>
            <th>volume</th>
            <th>fees</th>
            <th>rate</th>
            <th>epoch</th>
          </tr>
        </thead>
        <tbody>
          {#if currentEntries.length}
            {#each currentEntries as entry}
              <tr class:linked={entry.record} on:click={() => entry.record && selectRecord(entry.record)}>
                <td class="strong">{entry.thorname}</td>
                <td class="mono">{entry.pairLabel}</td>
                <td><span class={`pill ${entry.record?.stateKind || 'inactive'}`}>{entry.stateLabel}</span></td>
                <td class="accent">{formatBps(entry.dynamicBps)}</td>
                <td>{formatUsdCompact(entry.volumeUsd)}</td>
                <td>{formatUsdCompact(entry.feesUsd)}</td>
                <td>{formatRateBps(entry.rateBps)}</td>
                <td>E{entry.epoch}</td>
              </tr>
            {/each}
          {:else}
            <tr><td colspan="8" class="empty-cell">no live accumulators in current epoch</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  </section>
  {:else}
    <div class="affiliate-metrics">
      <article class="affiliate-metric">
        <span>whitelisted</span>
        <strong>{affiliates.length}</strong>
        <small>{model?.summary.activeWhitelistCount || 0} active / {model?.summary.monitorWhitelistCount || 0} monitor</small>
      </article>
      <article class="affiliate-metric">
        <span>live volume</span>
        <strong>{formatUsdCompact(model?.summary.affiliateLiveVolumeUsd || 0)}</strong>
        <small>current epoch</small>
      </article>
      <article class="affiliate-metric">
        <span>live fees paid</span>
        <strong>{formatUsdCompact(model?.summary.affiliateLiveFeesUsd || 0)}</strong>
        <small>{formatRateBps(model?.summary.affiliateLiveRateBps)} fees / volume</small>
      </article>
      <article class="affiliate-metric">
        <span>total fee revenue</span>
        <strong>{formatUsdCompact(model?.summary.totalAffiliateFeesUsd || 0)}</strong>
        <small>{formatRateBps(model?.summary.totalAffiliateRateBps)} fees / volume</small>
      </article>
    </div>

    <section class="block">
      <div class="block-head">
        <div class="block-title"><span class="title-marker">|</span><h2>Affiliate Trend</h2></div>
        <div class="block-meta">[{selectedAffiliate?.thorname || '--'} / {affiliateTimeframeOption.label}]</div>
      </div>

      <div class="affiliate-chart-toolbar">
        <div class="timeframe-tabs" role="tablist" aria-label="Affiliate chart timeframe">
          {#each AFFILIATE_TIMEFRAMES as option}
            <button
              type="button"
              role="tab"
              aria-selected={affiliateTimeframe === option.id}
              class:active={affiliateTimeframe === option.id}
              on:click={() => (affiliateTimeframe = option.id)}
            >
              {option.label}
            </button>
          {/each}
        </div>
      </div>

      <div class="selected-strip affiliate-selected-strip">
        <div>
          <span>affiliate</span>
          <strong>{selectedAffiliate?.thorname || '--'}</strong>
        </div>
        <div>
          <span>volume</span>
          <strong>{formatUsdCompact(affiliateHistory?.totalVolumeUsd || 0)}</strong>
        </div>
        <div>
          <span>fees</span>
          <strong>{formatUsdCompact(affiliateHistory?.totalFeesUsd || 0)}</strong>
        </div>
        <div>
          <span>fees / volume</span>
          <strong>{formatRateBps(affiliateHistory?.totalRateBps)}</strong>
        </div>
      </div>

      <div class="chart-frame affiliate-chart-frame">
        {#if affiliateHistoryLoading}
          <div class="loading-block"><span class="loading-marker">////</span><span>loading affiliate history</span></div>
        {:else if affiliateHistoryError}
          <div class="loading-block err"><span class="loading-marker">ERR</span><span>{affiliateHistoryError}</span></div>
        {:else if affiliateHistory?.points?.length}
          <canvas bind:this={affiliateChartCanvas}></canvas>
        {:else}
          <div class="loading-block"><span class="loading-marker">----</span><span>no historical affiliate metrics</span></div>
        {/if}
      </div>
    </section>

    <section class="block">
      <div class="block-head">
        <div class="block-title"><span class="title-marker">|</span><h2>Affiliate Registry</h2></div>
        <div class="block-meta">[{affiliates.length} whitelisted]</div>
      </div>

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>affiliate</th>
              <th>state</th>
              <th>pairs</th>
              <th>live volume</th>
              <th>live fees paid</th>
              <th>live fees / volume</th>
              <th>total volume</th>
              <th>total fees paid</th>
              <th>total fees / volume</th>
              <th>deduped</th>
            </tr>
          </thead>
          <tbody>
            {#if affiliates.length}
              {#each affiliates as affiliate}
                <tr
                  class:selected={selectedAffiliate?.id === affiliate.id}
                  on:click={() => selectAffiliate(affiliate)}
                  tabindex="0"
                  on:keydown={(event) => event.key === 'Enter' && selectAffiliate(affiliate)}
                >
                  <td class="strong">{affiliate.thorname}</td>
                  <td><span class={`pill ${affiliate.stateKind}`}>{affiliate.stateLabel}</span></td>
                  <td>{affiliate.pairCount} <span class="muted">/ {affiliate.livePairCount} live</span></td>
                  <td>{formatUsdCompact(affiliate.liveVolumeUsd)}</td>
                  <td>{formatUsdCompact(affiliate.liveFeesUsd)}</td>
                  <td>{formatRateBps(affiliate.liveRateBps)}</td>
                  <td>{formatUsdCompact(affiliate.totalVolumeUsd)}</td>
                  <td>{formatUsdCompact(affiliate.totalFeesUsd)}</td>
                  <td>{formatRateBps(affiliate.totalRateBps)}</td>
                  <td>{affiliate.mergedPairCount ? `${affiliate.mergedPairCount} pairs` : '--'}</td>
                </tr>
              {/each}
            {:else}
              <tr><td colspan="10" class="empty-cell">no whitelisted affiliates configured</td></tr>
            {/if}
          </tbody>
        </table>
      </div>
    </section>
  {/if}

  <div class="foot">
    <span>source /thornode dynamic_l1_fees</span>
    <span>affiliate trends /midgard history/affiliate</span>
    <span>history max 30 epochs</span>
    <span>TOR values shown as USD</span>
  </div>
</section>

<style>
  .terminal {
    width: min(1380px, calc(100vw - 24px));
    margin: 0 auto;
    padding: 24px 0 56px;
    color: #c8c8c8;
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 13px;
    line-height: 1.5;
  }

  .terminal h1,
  .terminal h2,
  .terminal strong {
    margin: 0;
  }

  .head {
    margin-bottom: 22px;
  }

  .head-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #555;
    margin-bottom: 14px;
  }

  .head-left,
  .head-right,
  .status,
  .socket-status,
  .refresh {
    display: flex;
    align-items: center;
  }

  .head-left {
    gap: 8px;
  }

  .head-right {
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .prompt,
  .key,
  .arrow,
  .cursor,
  .title-marker,
  .accent {
    color: #00cc66;
  }

  .prompt,
  .key {
    font-weight: 700;
  }

  .cmd {
    color: #c8c8c8;
    font-weight: 600;
  }

  .arg,
  .sep,
  .bracket {
    color: #333;
  }

  .status {
    gap: 6px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #888;
  }

  .socket-status {
    gap: 6px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #666;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #444;
  }

  .dot.ok {
    background: #00cc66;
    box-shadow: 0 0 6px rgba(0, 204, 102, 0.4);
    animation: pulse-dot 2s infinite;
  }

  .dot.warn {
    background: #d4a017;
    box-shadow: 0 0 6px rgba(212, 160, 23, 0.35);
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }

  .refresh {
    gap: 5px;
    background: transparent;
    border: 1px solid #1a1a1a;
    padding: 5px 10px;
    color: #888;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
    text-transform: lowercase;
  }

  .refresh:hover:not(:disabled) {
    border-color: #00cc66;
    color: #00cc66;
  }

  .refresh:disabled {
    opacity: 0.5;
    cursor: wait;
  }

  .title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 30px;
    font-weight: 800;
    color: #e8e8e8;
    letter-spacing: 0.06em;
    line-height: 1.1;
  }

  .cursor {
    animation: blink 1s steps(1) infinite;
    margin-left: 4px;
  }

  @keyframes blink {
    0%, 50% { opacity: 1; }
    50.01%, 100% { opacity: 0; }
  }

  .rule {
    height: 1px;
    background: linear-gradient(90deg, #00cc66 0%, #1a1a1a 14%, #1a1a1a 100%);
    margin-top: 16px;
  }

  .alerts {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 16px;
  }

  .alert {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border: 1px solid;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }

  .alert.err {
    border-color: rgba(220, 53, 69, 0.4);
    background: rgba(220, 53, 69, 0.06);
    color: #f08089;
  }

  .alert.warn {
    border-color: rgba(212, 160, 23, 0.4);
    background: rgba(212, 160, 23, 0.06);
    color: #e8c068;
  }

  .alert-tag {
    font-weight: 700;
    letter-spacing: 0.1em;
    flex-shrink: 0;
  }

  .block {
    border: 1px solid #1a1a1a;
    background: #0a0a0a;
    padding: 18px 20px 22px;
    margin-bottom: 14px;
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

  .block h2 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 700;
    color: #d8d8d8;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .block-meta {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    flex-shrink: 0;
  }

  .controller-grid {
    display: grid;
    grid-template-columns: minmax(210px, 0.85fr) minmax(320px, 1.45fr) minmax(240px, 1fr);
    gap: 0;
    border-top: 1px solid #141414;
  }

  .epoch-panel,
  .whitelist-panel {
    padding: 14px;
    border-right: 1px solid #141414;
    background: #080808;
  }

  .whitelist-panel {
    border-right: none;
  }

  .panel-label,
  .config-cell span,
  .selected-strip span,
  .state-row span,
  .decision-head span,
  .decision-body span {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.14em;
  }

  .panel-value {
    font-family: 'JetBrains Mono', monospace;
    color: #e8e8e8;
    font-size: 18px;
    font-weight: 800;
    margin: 8px 0;
  }

  .panel-foot {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #555;
    margin-top: 8px;
  }

  .progress-track {
    height: 8px;
    border: 1px solid #1a1a1a;
    background: #050505;
    overflow: hidden;
  }

  .progress-track span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, rgba(0, 204, 102, 0.35), #00cc66);
  }

  .config-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border-right: 1px solid #141414;
  }

  .config-cell {
    padding: 12px 14px;
    border-right: 1px solid #141414;
    border-bottom: 1px solid #141414;
    min-height: 70px;
  }

  .config-cell:nth-child(4n) {
    border-right: none;
  }

  .config-cell strong {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: #d8d8d8;
    margin-top: 8px;
  }

  .config-cell small {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #777;
    margin-top: 3px;
  }

  .whitelist-list {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 10px;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid #1a1a1a;
    background: #050505;
    color: #777;
    padding: 3px 7px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    white-space: nowrap;
  }

  .pill small {
    color: #444;
    font-size: 9px;
  }

  .pill.active {
    border-color: rgba(0, 204, 102, 0.45);
    color: #00cc66;
  }

  .pill.monitor {
    border-color: rgba(212, 160, 23, 0.45);
    color: #d4a017;
  }

  .pill.inactive {
    color: #555;
  }

  .dashboard-tabs {
    display: flex;
    gap: 0;
    border: 1px solid #1a1a1a;
    background: #070707;
    margin: -2px 0 14px;
    width: fit-content;
  }

  .dashboard-tabs button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    border-right: 1px solid #1a1a1a;
    color: #777;
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.1em;
    padding: 8px 12px;
    text-transform: uppercase;
  }

  .dashboard-tabs button:last-child {
    border-right: none;
  }

  .dashboard-tabs button:hover,
  .dashboard-tabs button.active {
    color: #00cc66;
    background: #0b0b0b;
  }

  .dashboard-tabs small {
    color: #444;
    font-size: 10px;
  }

  .dashboard-tabs button.active small {
    color: #008f48;
  }

  .affiliate-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border: 1px solid #1a1a1a;
    margin-bottom: 14px;
    background: #0a0a0a;
  }

  .affiliate-metric {
    border-right: 1px solid #1a1a1a;
    min-height: 104px;
    padding: 14px 16px;
  }

  .affiliate-metric:last-child {
    border-right: none;
  }

  .affiliate-metric span,
  .affiliate-metric small {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #555;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .affiliate-metric strong {
    display: block;
    color: #e8e8e8;
    font-family: 'JetBrains Mono', monospace;
    font-size: 20px;
    margin: 10px 0 4px;
  }

  .affiliate-metric small {
    font-size: 9px;
    letter-spacing: 0.08em;
  }

  .affiliate-chart-toolbar {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-bottom: 12px;
  }

  .timeframe-tabs {
    display: inline-flex;
    border: 1px solid #1a1a1a;
    background: #050505;
  }

  .timeframe-tabs button {
    background: transparent;
    border: none;
    border-right: 1px solid #1a1a1a;
    color: #777;
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    letter-spacing: 0.1em;
    padding: 7px 10px;
    text-transform: uppercase;
  }

  .timeframe-tabs button:last-child {
    border-right: none;
  }

  .timeframe-tabs button:hover,
  .timeframe-tabs button.active {
    color: #00cc66;
    background: #0b0b0b;
  }

  .affiliate-chart-frame {
    height: 372px;
  }

  .loading-block.err {
    color: #f08089;
  }

  .split {
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.85fr);
    gap: 14px;
    margin-bottom: 14px;
  }

  .chart-block {
    min-width: 0;
  }

  .selected-strip {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border: 1px solid #141414;
    margin-bottom: 12px;
  }

  .selected-strip div {
    padding: 10px 12px;
    border-right: 1px solid #141414;
    min-width: 0;
  }

  .selected-strip div:last-child {
    border-right: none;
  }

  .selected-strip strong {
    display: block;
    margin-top: 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: #e0e0e0;
    overflow-wrap: anywhere;
  }

  .chart-frame {
    height: 344px;
    background: #080808;
    border: 1px solid #111;
    padding: 12px;
  }

  .chart-frame canvas {
    width: 100%;
    height: 100%;
  }

  .loading-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 180px;
    height: 100%;
    color: #555;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .loading-marker {
    color: #00cc66;
  }

  .state-grid {
    border: 1px solid #141414;
  }

  .state-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid #141414;
    align-items: baseline;
  }

  .state-row:last-child {
    border-bottom: none;
  }

  .state-row strong,
  .decision-head strong,
  .decision-body strong {
    font-family: 'JetBrains Mono', monospace;
    color: #e0e0e0;
    font-size: 12px;
    text-align: right;
  }

  .decision-box {
    margin-top: 12px;
    border: 1px solid #141414;
    background: #080808;
  }

  .decision-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 12px;
    border-bottom: 1px solid #141414;
  }

  .decision-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 12px;
    padding: 12px;
  }

  .up {
    color: #00cc66 !important;
  }

  .down {
    color: #d4a017 !important;
  }

  .hold {
    color: #888 !important;
  }

  .table-controls {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .filter-tabs {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .filter-tabs button,
  .table-controls input {
    background: #050505;
    border: 1px solid #1a1a1a;
    color: #888;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
  }

  .filter-tabs button {
    padding: 6px 10px;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .filter-tabs button:hover,
  .filter-tabs button.active {
    border-color: rgba(0, 204, 102, 0.45);
    color: #00cc66;
  }

  .table-controls input {
    padding: 7px 10px;
    min-width: min(320px, 100%);
  }

  .table-scroll {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 900px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
  }

  th,
  td {
    padding: 8px 8px;
    text-align: left;
    vertical-align: middle;
    border-bottom: 1px solid #111;
  }

  th {
    color: #555;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    border-bottom: 1px solid #1a1a1a;
    background: #0a0a0a;
    position: sticky;
    top: 0;
    cursor: pointer;
    user-select: none;
  }

  th:nth-child(n + 4),
  td:nth-child(n + 4) {
    text-align: right;
  }

  td {
    color: #b8b8b8;
  }

  td.strong {
    color: #e0e0e0;
    font-weight: 700;
  }

  td.mono {
    color: #888;
  }

  tbody tr:hover,
  tbody tr.selected {
    background: #0d0d0d;
  }

  tbody tr.selected td:first-child {
    color: #00cc66;
  }

  tbody tr.linked,
  tbody tr[tabindex="0"] {
    cursor: pointer;
  }

  .move {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #777;
  }

  .muted {
    color: #555;
  }

  .empty-cell,
  .empty-line {
    color: #555;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .empty-cell {
    text-align: center !important;
    padding: 22px 8px;
  }

  .foot {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 16px;
    margin-top: 16px;
    border-top: 1px solid #1a1a1a;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  @media (max-width: 1120px) {
    .selected-strip,
    .affiliate-metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .selected-strip div:nth-child(2n),
    .affiliate-metric:nth-child(2n) {
      border-right: none;
    }

    .selected-strip div:nth-child(-n + 2),
    .affiliate-metric:nth-child(-n + 2) {
      border-bottom: 1px solid #1a1a1a;
    }

    .controller-grid,
    .split {
      grid-template-columns: 1fr;
    }

    .epoch-panel,
    .whitelist-panel,
    .config-grid {
      border-right: none;
      border-bottom: 1px solid #141414;
    }

    .whitelist-panel {
      border-bottom: none;
    }
  }

  @media (max-width: 640px) {
    .terminal {
      width: calc(100vw - 16px);
      padding: 16px 0 40px;
    }

    .head-top {
      align-items: flex-start;
      flex-direction: column;
    }

    .affiliate-metrics {
      grid-template-columns: 1fr;
    }

    .affiliate-metric,
    .affiliate-metric:nth-child(2n) {
      border-right: none;
      border-bottom: 1px solid #1a1a1a;
    }

    .affiliate-metric:last-child {
      border-bottom: none;
    }

    .head-right {
      justify-content: flex-start;
    }

    .title {
      font-size: 22px;
    }

    .selected-strip,
    .config-grid {
      grid-template-columns: 1fr;
    }

    .selected-strip div,
    .config-cell {
      border-right: none;
      border-bottom: 1px solid #1a1a1a;
    }

    .selected-strip div:last-child,
    .config-cell:last-child {
      border-bottom: none;
    }

    .block {
      padding: 14px 14px 18px;
    }

    .chart-frame {
      height: 280px;
    }

    .table-controls {
      flex-direction: column;
    }
  }
</style>
