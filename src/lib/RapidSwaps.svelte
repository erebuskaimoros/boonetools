<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { formatNumber, formatUSD, formatUSDCompact } from '$lib/utils/formatting';
  import { fromBaseUnit, normalizeAsset } from '$lib/utils/blockchain';
  import {
    fetchRapidSwapsDashboard,
    getRapidSwapsApiConfigError
  } from './rapid-swaps/api.js';
  import {
    computeDailyData,
    getChartDateRangeUnixSeconds,
    toChartDateKey
  } from './rapid-swaps/charts.js';
  import { midgard } from './api/midgard.js';
  import Chart from 'chart.js/auto';
  import { SankeyController, Flow } from 'chartjs-chart-sankey';
  Chart.register(SankeyController, Flow);

  const REFRESH_INTERVAL_MS = 120000;
  const RPC_WS_URL = 'wss://rpc.thorchain.network/websocket';
  const RECONNECT_BASE_MS = 2000;
  const RECONNECT_MAX_MS = 30000;
  const REFRESH_DEBOUNCE_MS = 8000;
  const PAGE_SIZE = 20;

  // --- State ---
  let loading = true;
  let refreshing = false;
  let dashboard = null;
  let dashboardError = '';
  let refreshInterval;
  let rpcWs = null;
  let rpcReconnectAttempt = 0;
  let rpcConnected = false;
  let rpcLastBlock = 0;
  let pendingRefreshTimer = null;
  let midgardHistoryRequestId = 0;

  // Tabs
  let activeTab = 'overview';

  // Overview date range filter (defaults to last 7 local days inclusive of today)
  let overviewDateFrom = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return toChartDateKey(d);
  })();
  let overviewDateTo = toChartDateKey(new Date());

  // Table filters + sorting
  let filterPath = '';
  let filterMinUsd = '';
  let filterMinSubs = '';
  let currentPage = 1;
  let sortColumn = 'date';
  let sortAsc = false;

  // Midgard total swap history (for market share charts)
  let midgardSwapHistory = null;

  // Chart instances (for cleanup)
  let chartInstances = {};

  $: allSwaps = dashboard?.all_swaps || dashboard?.recent_24h || [];
  $: topSwaps = dashboard?.top_20 || [];
  $: recentSwaps = dashboard?.recent_24h || [];
  $: trackerStart = dashboard?.tracker_started_at || null;
  $: backendMeta = dashboard?.backend || null;
  $: backendConfigError = getRapidSwapsApiConfigError();

  // Filtered + sorted + paginated table data
  $: filteredSwaps = filterSwaps(allSwaps, filterPath, filterMinUsd, filterMinSubs);
  $: sortedSwaps = sortSwaps(filteredSwaps, sortColumn, sortAsc);
  $: totalPages = Math.max(1, Math.ceil(sortedSwaps.length / PAGE_SIZE));
  $: {
    if (currentPage > totalPages) currentPage = 1;
  }
  $: pagedSwaps = sortedSwaps.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Filter swaps by overview date range
  $: overviewSwaps = allSwaps.filter(s => {
    const d = toChartDateKey(s.action_date);
    return d >= overviewDateFrom && d <= overviewDateTo;
  });

  // Daily aggregates for charts (includes market share when midgard data available)
  $: dailyData = computeDailyData(overviewSwaps, midgardSwapHistory);
  // Distribution data
  $: distributions = computeDistributions(overviewSwaps);
  // Swap path data
  $: swapPathData = computeSwapPathData(overviewSwaps);

  // --- Helpers ---
  function shortenAsset(asset) {
    if (!asset) return '-';
    // Strip hex contract addresses (0x...) and base58 addresses (long alphanumeric after -)
    const match = asset.match(/^(.+?)[-](?:0[Xx][A-Fa-f0-9]{8,}|[A-Za-z0-9]{20,})$/);
    if (match) return match[1];
    return asset;
  }

  function formatAsset(asset) {
    if (!asset) return '-';
    return shortenAsset(asset);
  }

  function formatPair(row) {
    return `${formatAsset(row?.source_asset)} → ${formatAsset(row?.target_asset)}`;
  }

  function shortPair(row) {
    return `${formatAsset(row?.source_asset)} → ${formatAsset(row?.target_asset)}`;
  }

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

  function formatTimeSaved(seconds) {
    const s = Number(seconds) || 0;
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  function swapPctFaster(row) {
    const subs = Number(row?.streaming_count) || 0;
    const blocks = Number(row?.blocks_used) || 0;
    if (subs <= 0 || blocks <= 0) return 0;
    return Math.round((1 - blocks / subs) * 100);
  }

  function swapTimeSaved(row) {
    const subs = Number(row?.streaming_count) || 0;
    const blocks = Number(row?.blocks_used) || 0;
    return Math.max(0, subs - blocks) * 6;
  }

  function getTxUrl(txId) {
    return `https://thorchain.net/tx/${txId}`;
  }

  // --- Filtering ---
  function filterSwaps(swaps, pathFilter, minUsd, minSubs) {
    let result = swaps;
    if (pathFilter) {
      const lower = pathFilter.toLowerCase();
      result = result.filter(row => {
        const pair = shortPair(row).toLowerCase();
        return pair.includes(lower);
      });
    }
    if (minUsd && Number(minUsd) > 0) {
      const min = Number(minUsd);
      result = result.filter(row => (Number(row.input_estimated_usd) || 0) >= min);
    }
    if (minSubs && Number(minSubs) > 0) {
      const min = Number(minSubs);
      result = result.filter(row => (Number(row.streaming_count) || 0) >= min);
    }
    return result;
  }

  function clearFilters() {
    filterPath = '';
    filterMinUsd = '';
    filterMinSubs = '';
    currentPage = 1;
  }

  function toggleSort(col) {
    if (sortColumn === col) {
      sortAsc = !sortAsc;
    } else {
      sortColumn = col;
      sortAsc = col === 'date' ? false : col === 'pair' ? true : false;
    }
    currentPage = 1;
  }

  function sortSwaps(swaps, col, asc) {
    const sorted = [...swaps];
    const dir = asc ? 1 : -1;
    sorted.sort((a, b) => {
      let va, vb;
      switch (col) {
        case 'date':
          va = new Date(a.action_date).getTime() || 0;
          vb = new Date(b.action_date).getTime() || 0;
          break;
        case 'pair':
          va = shortPair(a);
          vb = shortPair(b);
          return dir * va.localeCompare(vb);
        case 'usd':
          va = Number(a.input_estimated_usd) || 0;
          vb = Number(b.input_estimated_usd) || 0;
          break;
        case 'subs':
          va = Number(a.streaming_count) || 0;
          vb = Number(b.streaming_count) || 0;
          break;
        case 'blocks':
          va = Number(a.blocks_used) || 0;
          vb = Number(b.blocks_used) || 0;
          break;
        case 'timeSaved':
          va = swapTimeSaved(a);
          vb = swapTimeSaved(b);
          break;
        case 'pctFaster':
          va = swapPctFaster(a);
          vb = swapPctFaster(b);
          break;
        default:
          return 0;
      }
      return dir * (va - vb);
    });
    return sorted;
  }
  const AFFILIATE_NAMES = {
    't': 'THORSwap', '-t': 'THORSwap', 't1': 'Trust Wallet', '-_': 'SwapKit',
    'll': 'Live Ledger', 'ej': 'Edge Wallet', 'wr': 'THORWallet', 'dx': 'ASGARDEX',
    'bgw': 'BitGet Wallet', 'v0': 'Vultisig', 'rj': 'Rujira', 'ss': 'Shapeshift',
    'g1': 'GemWallet', 'ns': 'Native Swap', 'ahi': 'Ctrl', 'xdf': 'Ctrl',
    'hvl': 'SafePal', 'zengo': 'Zengo', 'ro': 'Rango Exchange', 'tps': 'Token Pocket',
    'leo': 'LEO Dex', 'is': 'InstaSwap', 'cbx': 'Coolwallet', 'c1': 'Clypto',
    'sto': 'THORChain', 'moca': 'Moca'
  };

  // Swap sites for DEXes/aggregators; wallets fall back to thorchain.net affiliate page
  const AFFILIATE_URLS = {
    't': 'https://app.thorswap.finance/swap', '-t': 'https://app.thorswap.finance/swap',
    '-_': 'https://app.swapkit.network/swap', 'sto': 'https://swap.thorchain.org',
    'dx': 'https://www.asgardex.com/', 'ss': 'https://app.shapeshift.com/',
    'rj': 'https://rujira.network/swap/', 'ro': 'https://rango.exchange/',
    'leo': 'https://thorchain.leodex.io/', 'is': 'https://instaswap.com/',
    'v0': 'https://launch.vultisig.com/', 'wr': 'https://www.thorwallet.org/',
    'll': 'https://liveledger.io/', 'ns': 'https://nativeswap.io/',
    'c1': 'https://clypto.com/'
  };

  function affiliateDisplayName(code) {
    return AFFILIATE_NAMES[code] || code;
  }

  function affiliateUrl(code) {
    return AFFILIATE_URLS[code] || `https://thorchain.net/charts/affiliates?affiliate=${encodeURIComponent(code)}`;
  }

  function computeDistributions(swaps) {
    const subBuckets = [
      { label: '2-10', min: 2, max: 10 },
      { label: '11-20', min: 11, max: 20 },
      { label: '21-30', min: 21, max: 30 },
      { label: '31-40', min: 31, max: 40 },
      { label: '41-50', min: 41, max: 50 },
      { label: '51+', min: 51, max: Infinity }
    ];

    const timeBuckets = [
      { label: '1-30s', min: 1, max: 30 },
      { label: '31-60s', min: 31, max: 60 },
      { label: '61-120s', min: 61, max: 120 },
      { label: '121-300s', min: 121, max: 300 },
      { label: '301s+', min: 301, max: Infinity }
    ];

    const subsByVolume = subBuckets.map(() => 0);
    const subsByCount = subBuckets.map(() => 0);
    const timeSavedDist = timeBuckets.map(() => 0);
    const affiliateCount = {};
    const affiliateVolume = {};

    for (const row of swaps) {
      const subs = Number(row.streaming_count) || 0;
      const usd = Number(row.input_estimated_usd) || 0;
      const saved = swapTimeSaved(row);

      for (let i = 0; i < subBuckets.length; i++) {
        if (subs >= subBuckets[i].min && subs <= subBuckets[i].max) {
          subsByVolume[i] += usd;
          subsByCount[i]++;
          break;
        }
      }

      if (saved > 0) {
        for (let i = 0; i < timeBuckets.length; i++) {
          if (saved >= timeBuckets[i].min && saved <= timeBuckets[i].max) {
            timeSavedDist[i]++;
            break;
          }
        }
      }

      const aff = row.affiliate || '';
      if (aff) {
        affiliateCount[aff] = (affiliateCount[aff] || 0) + 1;
        affiliateVolume[aff] = (affiliateVolume[aff] || 0) + usd;
      }
    }

    // Sort affiliates by count descending
    const affByCount = Object.entries(affiliateCount).sort((a, b) => b[1] - a[1]);
    const affByVolume = Object.entries(affiliateVolume).sort((a, b) => b[1] - a[1]);

    return {
      subLabels: subBuckets.map(b => b.label),
      subsByVolume,
      subsByCount,
      timeLabels: timeBuckets.map(b => b.label),
      timeSavedDist,
      affCountCodes: affByCount.map(([k]) => k),
      affCountLabels: affByCount.map(([k]) => affiliateDisplayName(k)),
      affCountValues: affByCount.map(([, v]) => v),
      affVolumeCodes: affByVolume.map(([k]) => k),
      affVolumeLabels: affByVolume.map(([k]) => affiliateDisplayName(k)),
      affVolumeValues: affByVolume.map(([, v]) => v)
    };
  }

  function computeSwapPathData(swaps) {
    const pathMap = {};
    const flowMap = {};
    for (const row of swaps) {
      const pair = shortPair(row);
      if (!pathMap[pair]) pathMap[pair] = { volume: 0, count: 0, totalTimeSaved: 0 };
      pathMap[pair].volume += Number(row.input_estimated_usd) || 0;
      pathMap[pair].count++;
      pathMap[pair].totalTimeSaved += swapTimeSaved(row);

      // Sankey flow data: source ticker → target ticker
      const src = formatAsset(row?.source_asset).split('.').pop() || '?';
      const tgt = formatAsset(row?.target_asset).split('.').pop() || '?';
      const flowKey = `${src}→${tgt}`;
      flowMap[flowKey] = (flowMap[flowKey] || 0) + (Number(row.input_estimated_usd) || 0);
    }

    const byVolume = Object.entries(pathMap)
      .sort((a, b) => b[1].volume - a[1].volume)
      .slice(0, 10);

    const byTimeSaved = Object.entries(pathMap)
      .filter(([, v]) => v.totalTimeSaved > 0)
      .sort((a, b) => (b[1].totalTimeSaved / b[1].count) - (a[1].totalTimeSaved / a[1].count))
      .slice(0, 10);

    // Sankey flows: top flows by volume, group small ones as "Others"
    const sortedFlows = Object.entries(flowMap).sort((a, b) => b[1] - a[1]);
    const topFlows = sortedFlows.slice(0, 10);
    const otherVolume = sortedFlows.slice(10).reduce((s, [, v]) => s + v, 0);
    const sankeyFlows = topFlows.map(([key, vol]) => {
      const [from, to] = key.split('→');
      return { from, to, flow: Math.round(vol) };
    });
    if (otherVolume > 0) {
      sankeyFlows.push({ from: 'Others', to: 'Others ', flow: Math.round(otherVolume) });
    }

    return {
      volumeLabels: byVolume.map(([k]) => k),
      volumeValues: byVolume.map(([, v]) => v.volume),
      timeSavedLabels: byTimeSaved.map(([k]) => k),
      timeSavedValues: byTimeSaved.map(([, v]) => Math.round(v.totalTimeSaved / v.count)),
      sankeyFlows
    };
  }

  // --- Chart rendering ---
  const CHART_COLORS = {
    green: '#00cc66',
    greenAlpha: 'rgba(0, 204, 102, 0.3)',
    amber: '#d4a017',
    amberAlpha: 'rgba(212, 160, 23, 0.3)',
    blue: '#5588cc',
    blueAlpha: 'rgba(85, 136, 204, 0.3)',
    red: '#cc4444',
    redAlpha: 'rgba(204, 68, 68, 0.3)',
    yellow: '#cccc33',
    yellowAlpha: 'rgba(204, 204, 51, 0.3)',
    grid: '#1a1a1a',
    text: '#666',
    bg: '#0d0d0d'
  };

  const baseChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
      legend: {
        display: false
      },
      tooltip: {
        backgroundColor: '#1a1a1a',
        titleColor: '#ccc',
        bodyColor: '#aaa',
        borderColor: '#333',
        borderWidth: 1,
        titleFont: { family: 'JetBrains Mono', size: 11 },
        bodyFont: { family: 'JetBrains Mono', size: 11 },
        padding: 8
      }
    },
    scales: {
      x: {
        grid: { color: CHART_COLORS.grid },
        ticks: { color: CHART_COLORS.text, font: { family: 'JetBrains Mono', size: 10 } }
      },
      y: {
        grid: { color: CHART_COLORS.grid },
        ticks: { color: CHART_COLORS.text, font: { family: 'JetBrains Mono', size: 10 } }
      }
    }
  };

  function destroyChart(id) {
    if (chartInstances[id]) {
      chartInstances[id].destroy();
      delete chartInstances[id];
    }
  }

  function createChart(canvasId, config) {
    destroyChart(canvasId);
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    chartInstances[canvasId] = new Chart(canvas, config);
  }

  function renderOverviewCharts() {
    if (!dailyData.labels.length) return;

    // Daily Volume + Cumulative
    createChart('chart-daily-volume', {
      type: 'bar',
      data: {
        labels: dailyData.labels,
        datasets: [
          {
            label: 'Volume',
            data: dailyData.volume,
            backgroundColor: CHART_COLORS.greenAlpha,
            borderColor: CHART_COLORS.green,
            borderWidth: 1,
            yAxisID: 'y',
            order: 2
          },
          {
            label: 'Cumulative',
            data: dailyData.cumVolume,
            type: 'line',
            borderColor: CHART_COLORS.amber,
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: CHART_COLORS.amber,
            yAxisID: 'y1',
            order: 1
          }
        ]
      },
      options: {
        ...baseChartOptions,
        plugins: {
          ...baseChartOptions.plugins,
          legend: { display: true, labels: { color: CHART_COLORS.text, font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 12 } },
          tooltip: {
            ...baseChartOptions.plugins.tooltip,
            callbacks: { label: ctx => `${ctx.dataset.label}: ${formatUSDCompact(ctx.parsed.y)}` }
          }
        },
        scales: {
          x: baseChartOptions.scales.x,
          y: {
            ...baseChartOptions.scales.y,
            position: 'left',
            ticks: { ...baseChartOptions.scales.y.ticks, callback: v => formatUSDCompact(v) }
          },
          y1: {
            ...baseChartOptions.scales.y,
            position: 'right',
            grid: { drawOnChartArea: false, color: CHART_COLORS.grid },
            ticks: { ...baseChartOptions.scales.y.ticks, callback: v => formatUSDCompact(v) }
          }
        }
      }
    });

    // Daily Count
    createChart('chart-daily-count', {
      type: 'bar',
      data: {
        labels: dailyData.labels,
        datasets: [
          {
            label: 'Count',
            data: dailyData.count,
            backgroundColor: CHART_COLORS.blueAlpha,
            borderColor: CHART_COLORS.blue,
            borderWidth: 1,
            yAxisID: 'y',
            order: 2
          },
          {
            label: 'Cumulative',
            data: dailyData.cumCount,
            type: 'line',
            borderColor: CHART_COLORS.amber,
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: CHART_COLORS.amber,
            yAxisID: 'y1',
            order: 1
          }
        ]
      },
      options: {
        ...baseChartOptions,
        plugins: {
          ...baseChartOptions.plugins,
          legend: { display: true, labels: { color: CHART_COLORS.text, font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 12 } },
          tooltip: {
            ...baseChartOptions.plugins.tooltip,
            callbacks: { label: ctx => `${ctx.dataset.label}: ${formatNumber(ctx.parsed.y)}` }
          }
        },
        scales: {
          x: baseChartOptions.scales.x,
          y: {
            ...baseChartOptions.scales.y,
            position: 'left',
            beginAtZero: true
          },
          y1: {
            ...baseChartOptions.scales.y,
            position: 'right',
            grid: { drawOnChartArea: false, color: CHART_COLORS.grid },
            beginAtZero: true
          }
        }
      }
    });

    // Efficiency Ratio
    createChart('chart-efficiency', {
      type: 'line',
      data: {
        labels: dailyData.labels,
        datasets: [{
          label: 'Efficiency',
          data: dailyData.efficiency,
          borderColor: CHART_COLORS.green,
          backgroundColor: CHART_COLORS.greenAlpha,
          fill: true,
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: CHART_COLORS.green,
          tension: 0.3
        }]
      },
      options: {
        ...baseChartOptions,
        scales: {
          x: baseChartOptions.scales.x,
          y: { ...baseChartOptions.scales.y, beginAtZero: false }
        }
      }
    });

    // Avg % Faster
    createChart('chart-pct-faster', {
      type: 'line',
      data: {
        labels: dailyData.labels,
        datasets: [{
          label: '% Faster',
          data: dailyData.pctFaster,
          borderColor: CHART_COLORS.amber,
          backgroundColor: CHART_COLORS.amberAlpha,
          fill: true,
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: CHART_COLORS.amber,
          tension: 0.3
        }]
      },
      options: {
        ...baseChartOptions,
        scales: {
          x: baseChartOptions.scales.x,
          y: { ...baseChartOptions.scales.y, ticks: { ...baseChartOptions.scales.y.ticks, callback: v => `${v}%` } }
        }
      }
    });

    // Market Share charts
    if (dailyData.volumePct.length) {
      const marketShareOpts = {
        ...baseChartOptions,
        scales: {
          x: baseChartOptions.scales.x,
          y: {
            ...baseChartOptions.scales.y,
            beginAtZero: true,
            ticks: { ...baseChartOptions.scales.y.ticks, callback: v => `${v}%` }
          }
        },
        plugins: {
          ...baseChartOptions.plugins,
          tooltip: {
            ...baseChartOptions.plugins.tooltip,
            callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y}%` }
          }
        }
      };

      createChart('chart-market-share-volume', {
        type: 'bar',
        data: {
          labels: dailyData.labels,
          datasets: [{
            label: '% of TC Volume',
            data: dailyData.volumePct,
            backgroundColor: CHART_COLORS.yellowAlpha,
            borderColor: CHART_COLORS.yellow,
            borderWidth: 1
          }]
        },
        options: marketShareOpts
      });

      createChart('chart-market-share-count', {
        type: 'bar',
        data: {
          labels: dailyData.labels,
          datasets: [{
            label: '% of TC Swaps',
            data: dailyData.countPct,
            backgroundColor: CHART_COLORS.redAlpha,
            borderColor: CHART_COLORS.red,
            borderWidth: 1
          }]
        },
        options: marketShareOpts
      });
    }
  }

  function renderDistributionCharts() {
    if (!distributions.subLabels.length) return;

    createChart('chart-subs-volume', {
      type: 'bar',
      data: {
        labels: distributions.subLabels,
        datasets: [{
          label: 'Volume',
          data: distributions.subsByVolume,
          backgroundColor: CHART_COLORS.greenAlpha,
          borderColor: CHART_COLORS.green,
          borderWidth: 1
        }]
      },
      options: {
        ...baseChartOptions,
        scales: {
          x: baseChartOptions.scales.x,
          y: { ...baseChartOptions.scales.y, ticks: { ...baseChartOptions.scales.y.ticks, callback: v => formatUSDCompact(v) } }
        }
      }
    });

    createChart('chart-subs-count', {
      type: 'bar',
      data: {
        labels: distributions.subLabels,
        datasets: [{
          label: 'TX Count',
          data: distributions.subsByCount,
          backgroundColor: CHART_COLORS.blueAlpha,
          borderColor: CHART_COLORS.blue,
          borderWidth: 1
        }]
      },
      options: {
        ...baseChartOptions,
        scales: {
          x: baseChartOptions.scales.x,
          y: { ...baseChartOptions.scales.y, beginAtZero: true }
        }
      }
    });

    createChart('chart-time-dist', {
      type: 'bar',
      data: {
        labels: distributions.timeLabels,
        datasets: [{
          label: 'TX Count',
          data: distributions.timeSavedDist,
          backgroundColor: CHART_COLORS.amberAlpha,
          borderColor: CHART_COLORS.amber,
          borderWidth: 1
        }]
      },
      options: {
        ...baseChartOptions,
        scales: {
          x: baseChartOptions.scales.x,
          y: { ...baseChartOptions.scales.y, beginAtZero: true }
        }
      }
    });

    // Affiliate charts
    if (distributions.affCountLabels?.length) {
      // Plugin to underline hovered y-axis label
      const affLabelHoverPlugin = {
        id: 'affLabelHover',
        afterDraw(chart) {
          const hIdx = chart._affHoveredIdx;
          if (hIdx == null) return;
          const yScale = chart.scales.y;
          if (!yScale) return;
          const label = chart.data.labels[hIdx];
          if (!label) return;
          const yPos = yScale.getPixelForValue(hIdx);
          const ctx = chart.ctx;
          ctx.save();
          ctx.font = '11px JetBrains Mono';
          const textWidth = ctx.measureText(label).width;
          const xEnd = yScale.right - 8;
          const xStart = xEnd - textWidth;
          ctx.strokeStyle = '#5588cc';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(xStart, yPos + 5);
          ctx.lineTo(xEnd, yPos + 5);
          ctx.stroke();
          ctx.restore();
        }
      };

      function attachAffLabelInteraction(canvasId, codes) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        function getYAxisIdx(evt) {
          const chart = chartInstances[canvasId];
          if (!chart) return null;
          const rect = canvas.getBoundingClientRect();
          const x = evt.clientX - rect.left;
          const y = evt.clientY - rect.top;
          const yScale = chart.scales.y;
          if (!yScale || x >= yScale.right || y < yScale.top || y > yScale.bottom) return null;
          return yScale.getValueForPixel(y);
        }

        canvas.addEventListener('click', (evt) => {
          const idx = getYAxisIdx(evt);
          if (idx != null && codes[idx]) {
            window.open(affiliateUrl(codes[idx]), '_blank');
          }
        });

        canvas.addEventListener('mousemove', (evt) => {
          const chart = chartInstances[canvasId];
          if (!chart) return;
          const idx = getYAxisIdx(evt);
          const prev = chart._affHoveredIdx;
          chart._affHoveredIdx = idx;
          canvas.style.cursor = idx != null ? 'pointer' : '';
          if (idx !== prev) chart.draw();
        });

        canvas.addEventListener('mouseleave', () => {
          const chart = chartInstances[canvasId];
          if (!chart) return;
          chart._affHoveredIdx = null;
          canvas.style.cursor = '';
          chart.draw();
        });
      }

      const affYAxis = {
        ...baseChartOptions.scales.y,
        ticks: {
          ...baseChartOptions.scales.y.ticks,
          font: { family: 'JetBrains Mono', size: 11 },
          color: '#5588cc'
        }
      };

      createChart('chart-aff-count', {
        type: 'bar',
        plugins: [affLabelHoverPlugin],
        data: {
          labels: distributions.affCountLabels,
          datasets: [{
            label: 'Swap Count',
            data: distributions.affCountValues,
            backgroundColor: CHART_COLORS.blueAlpha,
            borderColor: CHART_COLORS.blue,
            borderWidth: 1
          }]
        },
        options: {
          ...baseChartOptions,
          indexAxis: 'y',
          scales: {
            x: { ...baseChartOptions.scales.x, beginAtZero: true },
            y: affYAxis
          }
        }
      });
      attachAffLabelInteraction('chart-aff-count', distributions.affCountCodes);

      createChart('chart-aff-volume', {
        type: 'bar',
        plugins: [affLabelHoverPlugin],
        data: {
          labels: distributions.affVolumeLabels,
          datasets: [{
            label: 'Volume',
            data: distributions.affVolumeValues,
            backgroundColor: CHART_COLORS.greenAlpha,
            borderColor: CHART_COLORS.green,
            borderWidth: 1
          }]
        },
        options: {
          ...baseChartOptions,
          indexAxis: 'y',
          scales: {
            x: { ...baseChartOptions.scales.x, beginAtZero: true, ticks: { ...baseChartOptions.scales.x.ticks, callback: v => formatUSDCompact(v) } },
            y: affYAxis
          }
        }
      });
      attachAffLabelInteraction('chart-aff-volume', distributions.affVolumeCodes);
    }
  }

  function renderSwapPathCharts() {
    if (!swapPathData.volumeLabels.length) return;

    createChart('chart-paths-volume', {
      type: 'bar',
      data: {
        labels: swapPathData.volumeLabels,
        datasets: [{
          label: 'Volume',
          data: swapPathData.volumeValues,
          backgroundColor: CHART_COLORS.greenAlpha,
          borderColor: CHART_COLORS.green,
          borderWidth: 1
        }]
      },
      options: {
        ...baseChartOptions,
        indexAxis: 'y',
        scales: {
          x: { ...baseChartOptions.scales.x, ticks: { ...baseChartOptions.scales.x.ticks, callback: v => formatUSDCompact(v) } },
          y: { ...baseChartOptions.scales.y, ticks: { ...baseChartOptions.scales.y.ticks, font: { family: 'JetBrains Mono', size: 11 } } }
        }
      }
    });

    createChart('chart-paths-time', {
      type: 'bar',
      data: {
        labels: swapPathData.timeSavedLabels,
        datasets: [{
          label: 'Avg Time Saved',
          data: swapPathData.timeSavedValues,
          backgroundColor: CHART_COLORS.amberAlpha,
          borderColor: CHART_COLORS.amber,
          borderWidth: 1
        }]
      },
      options: {
        ...baseChartOptions,
        indexAxis: 'y',
        scales: {
          x: { ...baseChartOptions.scales.x, ticks: { ...baseChartOptions.scales.x.ticks, callback: v => formatTimeSaved(v) } },
          y: { ...baseChartOptions.scales.y, ticks: { ...baseChartOptions.scales.y.ticks, font: { family: 'JetBrains Mono', size: 11 } } }
        }
      }
    });

    // Sankey diagram
    if (swapPathData.sankeyFlows && swapPathData.sankeyFlows.length > 0) {
      const flowColors = [
        '#00cc66', '#d4a017', '#5588cc', '#cc6644', '#88cc44',
        '#cc44aa', '#44ccaa', '#aa88cc', '#ccaa44', '#44aacc', '#888888'
      ];
      // Assign a color per source asset
      const sourceAssets = [...new Set(swapPathData.sankeyFlows.map(f => f.from))];
      const colorMap = {};
      sourceAssets.forEach((asset, i) => { colorMap[asset] = flowColors[i % flowColors.length]; });

      createChart('chart-sankey', {
        type: 'sankey',
        data: {
          datasets: [{
            data: swapPathData.sankeyFlows,
            colorFrom: (c) => colorMap[c.dataset.data[c.dataIndex]?.from] || '#555',
            colorTo: (c) => {
              const color = colorMap[c.dataset.data[c.dataIndex]?.from] || '#555';
              // Fade to a dimmer version on the target side
              return color + '88';
            },
            colorMode: 'gradient',
            labels: Object.fromEntries(
              [...new Set(swapPathData.sankeyFlows.flatMap(f => [f.from, f.to]))].map(l => [l, l])
            ),
            size: 'max'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 300 },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#1a1a1a',
              borderColor: '#333',
              borderWidth: 1,
              titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
              bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
              titleColor: '#888',
              bodyColor: '#ccc',
              padding: 10,
              callbacks: {
                label: (ctx) => {
                  const item = ctx.dataset.data[ctx.dataIndex];
                  return `${item.from} → ${item.to}: ${formatUSDCompact(item.flow)}`;
                }
              }
            }
          },
          layout: { padding: { top: 8, bottom: 8 } }
        }
      });
    }
  }

  async function renderChartsForTab(tab) {
    await tick();
    if (tab === 'overview') renderOverviewCharts();
    else if (tab === 'distributions') renderDistributionCharts();
    else if (tab === 'paths') renderSwapPathCharts();
  }

  $: if (dashboard && activeTab) {
    midgardSwapHistory; // re-render when midgard data arrives
    overviewDateFrom; overviewDateTo; // re-render when date range changes
    renderChartsForTab(activeTab);
  }

  // --- WebSocket ---
  function tryDecodeAttr(val) {
    if (!val) return '';
    try {
      if (/^[A-Za-z0-9+/]+=*$/.test(val) && val.length > 1) {
        const decoded = atob(val);
        if (/^[\x20-\x7E]*$/.test(decoded) && decoded.length > 0) return decoded;
      }
    } catch (_) {}
    return val;
  }

  function checkBlockForRapidSwaps(msg) {
    try {
      const data = msg.result?.data?.value;
      if (!data) return;
      const blockHeight = Number(data.block?.header?.height) || 0;
      if (blockHeight > 0) rpcLastBlock = blockHeight;
      const events = data.result_finalize_block?.events || data.result_end_block?.events || [];
      for (const event of events) {
        if (event.type !== 'streaming_swap') continue;
        const attrs = {};
        for (const attr of event.attributes || []) {
          attrs[tryDecodeAttr(attr.key)] = tryDecodeAttr(attr.value);
        }
        if (Number(attrs.interval) === 0 && Number(attrs.quantity) > 1 && Number(attrs.count) > 0) {
          scheduleRefresh();
          return;
        }
      }
    } catch (_) {}
  }

  function scheduleRefresh() {
    clearTimeout(pendingRefreshTimer);
    pendingRefreshTimer = setTimeout(() => loadData(false), REFRESH_DEBOUNCE_MS);
  }

  function connectRpcWs() {
    try {
      rpcWs = new WebSocket(RPC_WS_URL);
      rpcWs.onopen = () => {
        rpcConnected = true;
        rpcReconnectAttempt = 0;
        rpcWs.send(JSON.stringify({
          jsonrpc: '2.0', method: 'subscribe', id: 1,
          params: { query: "tm.event='NewBlock'" }
        }));
      };
      rpcWs.onmessage = (e) => { try { checkBlockForRapidSwaps(JSON.parse(e.data)); } catch (_) {} };
      rpcWs.onclose = () => { rpcConnected = false; reconnectRpcWs(); };
      rpcWs.onerror = () => { rpcConnected = false; };
    } catch (_) {
      rpcConnected = false;
      reconnectRpcWs();
    }
  }

  function reconnectRpcWs() {
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, rpcReconnectAttempt), RECONNECT_MAX_MS);
    rpcReconnectAttempt++;
    setTimeout(connectRpcWs, delay);
  }

  function disconnectRpcWs() {
    if (rpcWs) { rpcWs.onclose = null; rpcWs.close(); rpcWs = null; }
    rpcConnected = false;
  }

  async function loadMidgardSwapHistory() {
    const swaps = dashboard?.all_swaps || [];
    if (!swaps.length || !overviewDateFrom || !overviewDateTo || overviewDateFrom > overviewDateTo) {
      midgardSwapHistory = null;
      return;
    }

    const range = getChartDateRangeUnixSeconds(overviewDateFrom, overviewDateTo);
    if (!range) {
      midgardSwapHistory = null;
      return;
    }

    const requestId = ++midgardHistoryRequestId;

    try {
      const history = await midgard.getSwapHistory({
        interval: 'hour',
        from: range.from,
        to: range.to
      }, {
        cache: false
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

  // --- Data loading ---
  async function loadData(showLoading = true) {
    if (showLoading) loading = true;
    else refreshing = true;
    try {
      dashboard = await fetchRapidSwapsDashboard();
      dashboardError = '';

      // Keep date range end pinned to today (handles midnight rollover)
      const today = toChartDateKey(new Date());
      if (overviewDateTo < today) {
        overviewDateTo = today;
      }
      await loadMidgardSwapHistory();
    } catch (err) {
      dashboard = null;
      dashboardError = err?.message || 'Failed to load recorded rapid swaps';
      midgardSwapHistory = null;
    }
    loading = false;
    refreshing = false;
  }

  onMount(() => {
    loadData(true);
    connectRpcWs();
    refreshInterval = setInterval(() => loadData(false), REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(refreshInterval);
      clearTimeout(pendingRefreshTimer);
      disconnectRpcWs();
      Object.keys(chartInstances).forEach(destroyChart);
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
        {#if trackerStart}
          <span class="sep">|</span>
          since {formatDateTime(trackerStart)}
        {/if}
        {#if !dashboard?.tracker_warmup_complete}
          <span class="sep">|</span>
          <span class="warn-text">warming up</span>
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
      <span class="ws-badge" class:ws-ok={rpcConnected} class:ws-down={!rpcConnected}>
        <span class="ws-dot"></span>
        {rpcConnected ? 'LIVE' : 'CONNECTING'}
        {#if rpcConnected && rpcLastBlock}
          <span class="sep">|</span>
          BLK {rpcLastBlock.toLocaleString()}
        {/if}
      </span>
      {#if refreshing}
        <span class="sep">|</span> REFRESHING...
      {/if}
    </span>
  </div>

  <!-- Sticky header: metrics + tabs -->
  <div class="sticky-header">
  <div class="metrics">
    <div class="metric">
      <div class="metric-val">{formatNumber(dashboard?.recent_24h_count || 0, { maximumFractionDigits: 0 })}</div>
      <div class="metric-key">24H COUNT</div>
    </div>
    <div class="metric">
      <div class="metric-val">{formatUSDCompact(dashboard?.recent_24h_volume_usd || 0)}</div>
      <div class="metric-key">24H VOLUME</div>
    </div>
    <div class="metric">
      <div class="metric-val accent">{formatNumber(dashboard?.total_tracked || 0, { maximumFractionDigits: 0 })}</div>
      <div class="metric-key">TOTAL SWAPS</div>
    </div>
    <div class="metric">
      <div class="metric-val accent">{formatUSDCompact(dashboard?.cumulative_volume_usd || 0)}</div>
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
      <div class="metric-val">{topSwaps[0] ? formatUSDCompact(topSwaps[0]?.input_estimated_usd || 0) : '--'}</div>
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
    <div class="date-range">
      <input type="date" class="date-input" bind:value={overviewDateFrom} on:change={() => loadMidgardSwapHistory()} />
      <span class="date-sep">–</span>
      <input type="date" class="date-input" bind:value={overviewDateTo} on:change={() => loadMidgardSwapHistory()} />
    </div>
  </div>
  </div><!-- /sticky-header -->

  <!-- Tab panels -->
  {#if activeTab === 'overview'}
    <!-- Daily Trends -->
    <section class="data-section">
      <div class="section-head">
        <h3>DAILY TRENDS</h3>
        <span class="section-sub">Grouped by your local day</span>
      </div>
      {#if loading && !dashboard}
        <div class="empty">Loading...</div>
      {:else if !allSwaps.length}
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
          <span class="section-sub">Rapid swaps as percentage of total THORChain activity, grouped by your local day</span>
        </div>
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
      </section>
    {/if}

    <!-- Execution Efficiency -->
    <section class="data-section">
      <div class="section-head">
        <h3>EXECUTION EFFICIENCY</h3>
        <span class="section-sub">Sub-swaps per block used (higher is better)</span>
      </div>
      {#if allSwaps.length}
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
        <span class="section-sub">Showing {filteredSwaps.length} of {allSwaps.length} swaps · timestamps shown in your local time</span>
      </div>

      <div class="table-filters">
        <input type="text" class="filter-input" placeholder="Filter by swap path" bind:value={filterPath} on:input={() => currentPage = 1} />
        <input type="number" class="filter-input filter-num" placeholder="Min USD volume" bind:value={filterMinUsd} on:input={() => currentPage = 1} />
        <input type="number" class="filter-input filter-num" placeholder="Min sub-swaps" bind:value={filterMinSubs} on:input={() => currentPage = 1} />
        {#if filterPath || filterMinUsd || filterMinSubs}
          <button class="filter-clear" on:click={clearFilters}>Clear Filters</button>
        {/if}
      </div>

      {#if loading && !dashboard}
        <div class="empty">Loading...</div>
      {:else if dashboardError}
        <div class="empty err-text">{dashboardError}</div>
      {:else if filteredSwaps.length === 0}
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
                  <td class="col-usd mono right accent">{formatUSD(row.input_estimated_usd || 0)}</td>
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
            <button class="page-btn" disabled={currentPage <= 1} on:click={() => currentPage--}>Prev</button>
            {#each Array(totalPages) as _, i}
              {#if totalPages <= 7 || i === 0 || i === totalPages - 1 || Math.abs(i + 1 - currentPage) <= 1}
                <button class="page-btn" class:page-active={currentPage === i + 1} on:click={() => currentPage = i + 1}>{i + 1}</button>
              {:else if i === 1 && currentPage > 3}
                <span class="page-dots">...</span>
              {:else if i === totalPages - 2 && currentPage < totalPages - 2}
                <span class="page-dots">...</span>
              {/if}
            {/each}
            <button class="page-btn" disabled={currentPage >= totalPages} on:click={() => currentPage++}>Next</button>
          </div>
        {/if}
      {/if}
    </section>

  {:else if activeTab === 'distributions'}
    <section class="data-section">
      <div class="section-head">
        <h3>SUB SWAPS DISTRIBUTION</h3>
      </div>
      {#if !allSwaps.length}
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
      {#if allSwaps.length}
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
      </div>
      {#if !allSwaps.length}
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
      {#if allSwaps.length}
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
    color: #c8c8c8;
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
    color: #666;
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
    color: #333;
    margin: 0 6px;
  }

  .warn-text {
    color: #b8860b;
  }

  .status-right {
    color: #555;
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

  .ws-down .ws-dot {
    background: #cc3333;
  }

  .ws-down {
    color: #cc3333;
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
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
    color: #e0e0e0;
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
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: #555;
    text-transform: uppercase;
  }

  .metric-sub {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: #444;
    margin-top: 4px;
  }

  .metric-largest {
    border-right: none;
  }

  .metric-stats {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: #555;
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
    color: #aaa;
    padding: 4px 8px;
    border-radius: 4px;
  }

  .date-input:focus {
    outline: none;
    border-color: #00cc66;
    color: #ddd;
  }

  .date-sep {
    color: #555;
    font-size: 11px;
  }

  .tab-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: #555;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 10px 16px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  .tab-btn:hover {
    color: #999;
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
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: #666;
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
    color: #ccc;
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
    color: #444;
  }

  .filter-clear {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    padding: 6px 12px;
    background: #1a1a1a;
    border: 1px solid #333;
    color: #888;
    border-radius: 3px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .filter-clear:hover {
    background: #222;
    color: #ccc;
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
    color: #888;
  }

  .section-sub {
    font-size: 11px;
    color: #444;
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
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #444;
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
    color: #aaa;
    vertical-align: middle;
  }

  .mono {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }

  .dim {
    color: #555;
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
    color: #888;
    border-radius: 3px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .page-btn:hover:not(:disabled) {
    background: #1a1a1a;
    color: #ccc;
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
    color: #444;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 0 4px;
  }

  /* ---- EMPTY / ERROR ---- */
  .empty {
    padding: 24px 16px;
    color: #444;
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
      font-size: 10px;
      flex-wrap: wrap;
      gap: 4px;
    }

    th, td {
      padding: 8px 10px;
    }

    .tab-btn {
      padding: 8px 10px;
      font-size: 10px;
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
