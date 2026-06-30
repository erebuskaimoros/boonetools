<script>
  import { onMount } from 'svelte';
  import Chart from 'chart.js/auto';

  const DATA_BASE = '/data/rujira-base-layer-fees';
  const APP_LAYER_API_BASE = (
    import.meta.env.VITE_APP_LAYER_API_BASE ||
    import.meta.env.VITE_NODEOP_API_BASE ||
    '/functions/v1'
  ).replace(/\/$/, '');
  const APP_LAYER_API_KEY =
    import.meta.env.VITE_APP_LAYER_API_KEY || import.meta.env.VITE_NODEOP_API_KEY || '';
  const THORCHAIN_NET_BASE = 'https://thorchain.net';
  const BASE_LAYER_COLLECTOR =
    'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr';
  const RESERVE_MODULE = 'thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt';
  const RUJI_STAKER_COLLECTOR =
    'thor13g83nn5ef4qzqeafp0508dnvkvm0zqr3sj7eefcn5umu65gqluusrml5cr';

  const collectors = [
    {
      key: 'trade',
      name: 'RUJI Trade',
      address: 'thor1gm8q2gr25nzzsxzdp2mpja4hyvyhjlr4s6krcsgv2y953uu0js3qhwpus7',
      role: 'Orderbook revenue collector'
    },
    {
      key: 'core',
      name: 'Other Core Apps',
      address: 'thor1jduxxzpyyvrgzx7zcnl7e5cdj34tnq5jxy00a4wp86szye25dndq575c0y',
      role: 'Core app revenue collector'
    },
    {
      key: 'swap',
      name: 'RUJI Swap',
      address: 'thor1mcy9jtp4kzl8q2lvdgfgsl8jvqrf504uphkf0pz2p9wud8tsntesjvccew',
      role: 'Swap and staker-side collector'
    },
    {
      key: 'index',
      name: 'RUJI Index',
      address: 'thor132u9qpm9gfdqtgwxwl8ty409s6zmewfrum2k6wvtvtyphdn5urzsej764l',
      role: 'Index revenue collector'
    },
    {
      key: 'base',
      name: 'Base Layer Collector',
      address: BASE_LAYER_COLLECTOR,
      role: 'Final app-layer collector for TC Reserve payments'
    }
  ];

  const staticTargets = {
    trade: [
      { label: 'RUJI staker collector', address: collectors[2].address, percent: 50 },
      { label: 'Base Layer Collector', address: BASE_LAYER_COLLECTOR, percent: 50 }
    ],
    core: [
      { label: 'RUJI staker collector', address: collectors[2].address, percent: 50 },
      { label: 'Base Layer Collector', address: BASE_LAYER_COLLECTOR, percent: 50 }
    ],
    swap: [{ label: 'RUJI staker collector', address: RUJI_STAKER_COLLECTOR, percent: 100 }],
    index: [{ label: 'RUJI staker collector', address: collectors[2].address, percent: 100 }],
    base: [{ label: 'TC Reserve', address: RESERVE_MODULE, percent: 100 }]
  };

  const addressLabels = {
    [BASE_LAYER_COLLECTOR]: 'Base Layer Collector',
    [RESERVE_MODULE]: 'TC Reserve',
    [RUJI_STAKER_COLLECTOR]: 'RUJI staker collector',
    [collectors[0].address]: 'RUJI Trade',
    [collectors[1].address]: 'Other Core Apps',
    [collectors[2].address]: 'RUJI Swap',
    [collectors[3].address]: 'RUJI Index'
  };

  const versionTimeline = [
    {
      date: '2025-06-02',
      collector: 'Base Layer Collector',
      event: 'Initialized on code 6',
      flow: 'RUNE target pointed directly to the TC Reserve module'
    },
    {
      date: '2025-06-02',
      collector: 'Other Core Apps',
      event: 'Initialized on code 6',
      flow: '50% target path included the Base Layer collector'
    },
    {
      date: '2025-08-29',
      collector: 'RUJI Trade',
      event: 'Initialized on code 6',
      flow: '50% target path included the Base Layer collector'
    },
    {
      date: '2026-04-30 07:19 UTC',
      collector: 'Current collectors',
      event: 'Migrated to code 157',
      flow: 'Expanded target denoms and route configs'
    },
    {
      date: '2026-04-30 18:28 UTC',
      collector: 'Current collectors',
      event: 'Migrated to code 159',
      flow: 'Current payment execution code'
    },
    {
      date: '2026-04-30 18:32 UTC',
      collector: 'Base Layer Collector',
      event: 'First observed RESERVE deposit',
      flow: 'Final payment from app-layer collector into TC Reserve'
    }
  ];

  const similarContracts = [
    {
      label: 'AUTO_revenue_converter',
      codeId: '6',
      address: 'thor1jjv0nu4pwh9swuv3q349fp54m59j60zc4nr6ztw3ajd8ggcyz3sqm79zlk',
      target: 'Owner address only'
    },
    {
      label: 'auto_v2_revenue_converter',
      codeId: '6',
      address: 'thor16nvznymm37g3jxq9n004aqu46v7563zc9wmvlgz6xglersx4cpgqkxuty9',
      target: 'Owner address only'
    },
    {
      label: 'rujira-revenue:test',
      codeId: '157',
      address: 'thor1qtyae4h665djc8vgkfmyavyg98e72nq8es3hmavqgnclvg79kl3sa8lxa2',
      target: 'Test target, not TC Reserve'
    },
    {
      label: 'liquidy-revenue:swap-router',
      codeId: '157',
      address: 'thor1fc2rcjp437wnm59q7f58wg9x6um7av9ky0cxgrksafqh8a7q8l6s9afslw',
      target: 'Swap-router target, not TC Reserve'
    }
  ];
  const EMPTY_REVENUE_SUMMARY = {
    pricedUsd: 0,
    pricedAssetCount: 0,
    unpricedAssetCount: 0,
    distributionTxCount: 0,
    distributionTransferCount: 0,
    assets: []
  };

  let weeklyRows = [];
  let reserveEvents = [];
  let staticWeeklyRows = [];
  let staticReserveEvents = [];
  let staticReserveMeta = null;
  let collectorRevenue = null;
  let generatedFees = null;
  let staticGeneratedFees = null;
  let meta = null;
  let configs = {};
  let histories = {};
  let balances = [];
  let poolPrices = {};
  let runePriceUsd = 0;
  let artifactsLoading = true;
  let reservePaymentsLoading = true;
  let generatedFeesLoading = true;
  let liveLoading = true;
  let artifactsError = '';
  let reservePaymentsError = '';
  let reservePaymentsWarning = '';
  let generatedFeesError = '';
  let generatedFeesWarning = '';
  let liveError = '';
  let liveRouteWarning = '';
  let lastLiveRefresh = null;
  let paymentCanvas;
  let paymentChart;
  let generatedFeesCanvas;
  let generatedFeesChart;

  const usd0 = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  });
  const usd2 = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  });
  const number2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const number4 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

  $: latestWeek = weeklyRows.at(-1) || null;
  $: firstEvent = reserveEvents[0] || null;
  $: latestEvent = reserveEvents.at(-1) || null;
  $: recentEvents = reserveEvents.slice(-8).reverse();
  $: reservePaymentMeta = meta || {};
  $: reservePaymentPendingBlocks = Number(reservePaymentMeta.pendingBlockCount || 0);
  $: reservePaymentBackfillLabel = reservePaymentMeta.backfillComplete
    ? 'backfill complete'
    : `${number2.format(reservePaymentPendingBlocks)} blocks queued`;
  $: reservePriceBasis =
    reservePaymentMeta.priceBasis ||
    'amount RUNE × Dune daily THORChain pool RUNE/USD for each Reserve deposit date';
  $: latestReservePrice = latestWeek?.rune_price_usd || 0;
  $: reservePriceRange = getWeeklyPriceRange(weeklyRows);
  $: generatedFeeRows = generatedFees?.weekly || [];
  $: latestGeneratedFeeWeek = generatedFeeRows.at(-1) || null;
  $: generatedFeeMeta = generatedFees?.meta || null;
  $: generatedFeeRoutes = generatedFees?.routes || [];
  $: topGeneratedFeeRoutes = generatedFeeRoutes.slice(0, 8);
  $: totalGeneratedFeeRune =
    generatedFeeMeta?.totalLiquidityFeeRune || latestGeneratedFeeWeek?.cumulative_rune || 0;
  $: totalGeneratedFeeUsd =
    generatedFeeMeta?.totalLiquidityFeeUsd || latestGeneratedFeeWeek?.cumulative_usd || 0;
  $: generatedFeeScope = generatedFeeMeta?.scope || 'pending generated-fee scan';
  $: generatedFeePendingBlocks = Number(generatedFeeMeta?.pendingBlockCount || 0);
  $: generatedFeeBackfillLabel = generatedFeeMeta?.backfillComplete
    ? 'backfill complete'
    : `${number2.format(generatedFeePendingBlocks)} blocks queued`;
  $: pendingRune = amountFromBase(
    balances.find((balance) => balance.denom === 'rune')?.amount || 0
  );
  $: pendingRuneUsd = pendingRune * runePriceUsd;
  $: stableUsd = balances.filter((balance) => isStableDenom(balance.denom)).reduce(
    (sum, balance) => sum + amountFromBase(balance.amount),
    0
  );
  $: pendingKnownUsd = pendingRuneUsd + stableUsd;
  $: collectorRevenueMap = Object.fromEntries(
    (collectorRevenue?.collectors || []).map((collector) => [collector.key, collector])
  );
  $: appCollectorRows = collectors
    .filter((collector) => collector.key !== 'base')
    .map((collector) => ({
      ...collector,
      revenueSummary: collectorRevenueMap[collector.key] || EMPTY_REVENUE_SUMMARY
    }));
  $: targetMap = Object.fromEntries(
    collectors.map((collector) => [
      collector.key,
      getTargetsForConfig(collector.key, configs[collector.key])
    ])
  );
  $: baseShares = Object.fromEntries(
    collectors.map((collector) => [
      collector.key,
      (targetMap[collector.key] || []).find((target) => target.address === BASE_LAYER_COLLECTOR)
        ?.percent || 0
    ])
  );
  $: historyLabels = Object.fromEntries(
    collectors.map((collector) => [
      collector.key,
      summarizeHistory(histories[collector.key] || [])
    ])
  );
  $: latestCodeIds = Object.fromEntries(
    collectors.map((collector) => [
      collector.key,
      histories[collector.key]?.at(-1)?.code_id || (configs[collector.key] ? 'live' : '...')
    ])
  );
  $: topBalances = balances
    .map((balance) => ({
      ...balance,
      amountDisplay: formatAssetAmount(balance),
      usdValue: estimateUsd(balance)
    }))
    .filter((balance) => Number(balance.amount) > 0)
    .sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0))
    .slice(0, 8);

  $: if (paymentCanvas && weeklyRows.length) {
    renderPaymentChart(weeklyRows);
  }
  $: if (generatedFeesCanvas && generatedFeeRows.length) {
    renderGeneratedFeesChart(generatedFeeRows);
  }

  onMount(() => {
    loadArtifacts().then(() => {
      refreshReservePayments();
      refreshGeneratedFees();
    });
    refreshLiveState();

    return () => {
      paymentChart?.destroy();
      generatedFeesChart?.destroy();
    };
  });

  async function fetchDataFile(name, parser = (value) => value) {
    const response = await fetch(`${DATA_BASE}/${name}`);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return parser(await response.text());
  }

  async function loadArtifacts() {
    try {
      artifactsLoading = true;
      artifactsError = '';
      generatedFeesError = '';
      generatedFeesWarning = '';
      const [csvRows, eventRows, revenueJson, metaJson, generatedFeesResult] = await Promise.all([
        fetchDataFile('rujira-base-layer-fees.csv', parseCsv),
        fetchDataFile('rujira-base-layer-fees-events.json', JSON.parse),
        fetchDataFile('rujira-collector-revenue.json', JSON.parse),
        fetchDataFile('rujira-base-layer-fees-meta.json', JSON.parse),
        fetchDataFile('rujira-app-layer-swap-fees.json', JSON.parse).catch((error) => ({
          __error: error.message
        }))
      ]);

      staticWeeklyRows = csvRows;
      staticReserveEvents = eventRows.map((event) => normalizeReserveEvent(event, csvRows));
      staticReserveMeta = metaJson;
      collectorRevenue = revenueJson;
      if (generatedFeesResult?.__error) {
        staticGeneratedFees = null;
      } else {
        staticGeneratedFees = generatedFeesResult;
      }
    } catch (error) {
      artifactsError = error.message;
    } finally {
      artifactsLoading = false;
    }
  }

  async function refreshReservePayments() {
    try {
      reservePaymentsLoading = true;
      reservePaymentsError = '';
      reservePaymentsWarning = '';
      const payload = await fetchAppLayerReservePayments();
      if (!Array.isArray(payload?.weekly) || !Array.isArray(payload?.events)) {
        throw new Error('invalid reserve-payment payload');
      }
      const staticEventCount = Number(staticReserveMeta?.eventCount || 0);
      const dbEventCount = Number(payload?.meta?.eventCount || 0);
      if (staticEventCount > dbEventCount && !payload?.meta?.backfillComplete && staticWeeklyRows.length) {
        weeklyRows = staticWeeklyRows;
        reserveEvents = staticReserveEvents;
        meta = {
          ...staticReserveMeta,
          dbBackfill: payload.meta || {},
          backfillComplete: false,
          pendingBlockCount: payload.meta?.pendingBlockCount || 0,
          fetchedBlockCount: payload.meta?.fetchedBlockCount || 0
        };
        reservePaymentsWarning = `reserve-payment DB backfill in progress — ${dbEventCount}/${staticEventCount} events loaded; using static fallback`;
        return;
      }
      weeklyRows = payload.weekly;
      reserveEvents = payload.events.map((event) => normalizeReserveEvent(event, payload.weekly));
      meta = payload.meta || {};
    } catch (error) {
      if (weeklyRows.length) {
        reservePaymentsWarning = String(error.message || '').startsWith('404')
          ? ''
          : `reserve-payment DB — ${error.message}; using last successful payload`;
      } else if (staticWeeklyRows.length) {
        weeklyRows = staticWeeklyRows;
        reserveEvents = staticReserveEvents;
        meta = staticReserveMeta;
        reservePaymentsWarning = String(error.message || '').startsWith('404')
          ? ''
          : `reserve-payment DB — ${error.message}; using static fallback`;
      } else {
        reservePaymentsError = `reserve-payment DB — ${error.message}`;
      }
    } finally {
      reservePaymentsLoading = false;
    }
  }

  async function refreshGeneratedFees() {
    try {
      generatedFeesLoading = true;
      generatedFeesError = '';
      generatedFeesWarning = '';
      const payload = await fetchAppLayerBaseFees();
      if (!Array.isArray(payload?.weekly)) {
        throw new Error('invalid generated-fee payload');
      }
      generatedFees = payload;
    } catch (error) {
      if (generatedFees) {
        generatedFeesWarning = String(error.message || '').startsWith('404')
          ? ''
          : `generated-fee DB — ${error.message}; using last successful payload`;
      } else if (staticGeneratedFees) {
        generatedFees = staticGeneratedFees;
        generatedFeesWarning = String(error.message || '').startsWith('404')
          ? ''
          : `generated-fee DB — ${error.message}; using static fallback`;
      } else {
        generatedFeesError = `generated-fee DB — ${error.message}`;
      }
    } finally {
      generatedFeesLoading = false;
    }
  }

  async function refreshLiveState() {
    try {
      liveLoading = true;
      liveError = '';
      liveRouteWarning = '';
      const liveState = await fetchAppLayerLiveState();

      runePriceUsd = amountFromBase(liveState.network?.rune_price_in_tor);
      poolPrices = buildPoolPrices(liveState.pools || []);
      balances = liveState.balances || [];
      configs = liveState.configs || {};
      histories = liveState.histories || {};
      liveRouteWarning = liveState.warning || '';
      lastLiveRefresh = new Date(liveState.as_of || liveState.fetched_at || Date.now());
    } catch (error) {
      liveError = error.message;
    } finally {
      liveLoading = false;
    }
  }

  async function fetchAppLayerLiveState() {
    const headers = APP_LAYER_API_KEY
      ? { apikey: APP_LAYER_API_KEY, Authorization: `Bearer ${APP_LAYER_API_KEY}` }
      : {};
    const response = await fetch(`${APP_LAYER_API_BASE}/app-layer-live-state`, {
      headers,
      cache: 'no-store'
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
    }

    return JSON.parse(text);
  }

  async function fetchAppLayerBaseFees() {
    const headers = APP_LAYER_API_KEY
      ? { apikey: APP_LAYER_API_KEY, Authorization: `Bearer ${APP_LAYER_API_KEY}` }
      : {};
    const response = await fetch(`${APP_LAYER_API_BASE}/app-layer-base-fees`, {
      headers,
      cache: 'no-store'
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
    }

    return JSON.parse(text);
  }

  async function fetchAppLayerReservePayments() {
    const headers = APP_LAYER_API_KEY
      ? { apikey: APP_LAYER_API_KEY, Authorization: `Bearer ${APP_LAYER_API_KEY}` }
      : {};
    const response = await fetch(`${APP_LAYER_API_BASE}/app-layer-reserve-payments`, {
      headers,
      cache: 'no-store'
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
    }

    return JSON.parse(text);
  }

  function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    const headers = lines.shift()?.split(',') || [];
    const numericFields = new Set([
      'payments',
      'payment_rune',
      'rune_price_usd',
      'payment_usd',
      'cumulative_rune',
      'cumulative_usd'
    ]);

    return lines.map((line) => {
      const values = line.split(',');
      return Object.fromEntries(
        headers.map((header, index) => [
          header,
          numericFields.has(header) ? Number(values[index]) : values[index]
        ])
      );
    });
  }

  function renderPaymentChart(rows) {
    if (!paymentCanvas) return;
    const ctx = paymentCanvas.getContext('2d');
    paymentChart?.destroy();

    paymentChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: rows.map((row) => formatWeekLabel(row.week_start)),
        datasets: [
          {
            type: 'bar',
            label: 'Weekly paid USD at deposit price',
            data: rows.map((row) => row.payment_usd),
            backgroundColor: 'rgba(0, 204, 102, 0.55)',
            borderColor: '#00cc66',
            borderWidth: 1,
            borderRadius: 0,
            yAxisID: 'weekly'
          },
          {
            type: 'line',
            label: 'Cumulative paid USD at deposit price',
            data: rows.map((row) => row.cumulative_usd),
            borderColor: '#d4a017',
            backgroundColor: '#d4a017',
            pointBackgroundColor: '#d4a017',
            pointBorderColor: '#080808',
            pointRadius: 3,
            borderWidth: 2,
            tension: 0.2,
            yAxisID: 'cumulative'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            labels: {
              color: '#888',
              boxWidth: 10,
              usePointStyle: true,
              font: { family: "'JetBrains Mono', monospace", size: 10 }
            }
          },
          tooltip: {
            backgroundColor: '#0a0a0a',
            borderColor: '#1a1a1a',
            borderWidth: 1,
            titleColor: '#00cc66',
            bodyColor: '#c8c8c8',
            titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
            callbacks: {
              afterBody(items) {
                const row = rows[items[0].dataIndex];
                return [
                  `${number2.format(row.payment_rune)} RUNE paid`,
                  `${number4.format(row.rune_price_usd)} avg historical RUNE/USD`,
                  `${number2.format(row.cumulative_rune)} cumulative RUNE`
                ];
              },
              label(context) {
                return `${context.dataset.label}: ${usd2.format(context.raw)}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: '#111', drawBorder: false },
            border: { color: '#1a1a1a' },
            ticks: { color: '#666', font: { family: "'JetBrains Mono', monospace", size: 10 } }
          },
          weekly: {
            position: 'left',
            grid: { color: '#111', drawBorder: false },
            border: { color: '#1a1a1a' },
            ticks: {
              color: '#00cc66',
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              callback: (value) => usd0.format(value)
            }
          },
          cumulative: {
            position: 'right',
            grid: { drawOnChartArea: false },
            border: { color: '#1a1a1a' },
            ticks: {
              color: '#d4a017',
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              callback: (value) => usd0.format(value)
            }
          }
        }
      }
    });
  }

  function renderGeneratedFeesChart(rows) {
    if (!generatedFeesCanvas) return;
    const ctx = generatedFeesCanvas.getContext('2d');
    generatedFeesChart?.destroy();

    generatedFeesChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: rows.map((row) => formatWeekLabel(row.week_start)),
        datasets: [
          {
            type: 'bar',
            label: 'Weekly generated fees USD',
            data: rows.map((row) => row.liquidity_fee_usd),
            backgroundColor: 'rgba(68, 160, 255, 0.35)',
            borderColor: '#44a0ff',
            borderWidth: 1,
            borderRadius: 0,
            yAxisID: 'weekly'
          },
          {
            type: 'line',
            label: 'Cumulative generated fees USD',
            data: rows.map((row) => row.cumulative_usd),
            borderColor: '#00cc66',
            backgroundColor: '#00cc66',
            pointBackgroundColor: '#00cc66',
            pointBorderColor: '#080808',
            pointRadius: 3,
            borderWidth: 2,
            tension: 0.2,
            yAxisID: 'cumulative'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            labels: {
              color: '#888',
              boxWidth: 10,
              usePointStyle: true,
              font: { family: "'JetBrains Mono', monospace", size: 10 }
            }
          },
          tooltip: {
            backgroundColor: '#0a0a0a',
            borderColor: '#1a1a1a',
            borderWidth: 1,
            titleColor: '#44a0ff',
            bodyColor: '#c8c8c8',
            titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
            callbacks: {
              afterBody(items) {
                const row = rows[items[0].dataIndex];
                return [
                  `${number4.format(row.liquidity_fee_rune)} RUNE fees`,
                  `${number4.format(row.rune_price_usd)} RUNE/USD`,
                  `${number4.format(row.cumulative_rune)} cumulative RUNE`
                ];
              },
              label(context) {
                return `${context.dataset.label}: ${usd2.format(context.raw)}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: '#111', drawBorder: false },
            border: { color: '#1a1a1a' },
            ticks: { color: '#666', font: { family: "'JetBrains Mono', monospace", size: 10 } }
          },
          weekly: {
            position: 'left',
            grid: { color: '#111', drawBorder: false },
            border: { color: '#1a1a1a' },
            ticks: {
              color: '#44a0ff',
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              callback: (value) => usd2.format(value)
            }
          },
          cumulative: {
            position: 'right',
            grid: { drawOnChartArea: false },
            border: { color: '#1a1a1a' },
            ticks: {
              color: '#00cc66',
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              callback: (value) => usd2.format(value)
            }
          }
        }
      }
    });
  }

  function getTargetsForConfig(collectorKey, config) {
    const targetRows = config?.target_addresses;
    if (!Array.isArray(targetRows) || !targetRows.length) {
      return staticTargets[collectorKey] || [];
    }

    const totalWeight = targetRows.reduce((sum, [, weight]) => sum + Number(weight || 0), 0);
    return targetRows.map(([address, weight]) => ({
      address,
      label: addressLabels[address] || formatAddress(address),
      percent: totalWeight > 0 ? (Number(weight) / totalWeight) * 100 : 0
    }));
  }

  function amountFromBase(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric / 1e8 : 0;
  }

  function normalizeReserveEvent(event, priceRows = []) {
    const amountRune = Number(event.amountRune ?? event.amount_rune ?? amountFromBase(event.amountBase));
    const runePriceUsd = Number(
      event.runePriceUsd ??
      event.rune_price_usd ??
      reservePriceForDate(event.date, priceRows)
    );
    const amountUsd = Number(event.amountUsd ?? event.amount_usd ?? amountRune * runePriceUsd);
    return {
      ...event,
      amountRune,
      runePriceUsd,
      amountUsd
    };
  }

  function reservePriceForDate(value, rows = weeklyRows) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 0;
    const match = (rows || []).find((row) => {
      const start = new Date(`${row.week_start}T00:00:00Z`);
      const end = new Date(`${row.week_end}T00:00:00Z`);
      return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && date >= start && date < end;
    });
    return Number(match?.rune_price_usd || 0);
  }

  function getWeeklyPriceRange(rows) {
    const prices = (rows || []).map((row) => Number(row.rune_price_usd || 0)).filter((price) => price > 0);
    if (!prices.length) return '';
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    if (Math.abs(low - high) < 0.000001) return `$${number4.format(low)}`;
    return `$${number4.format(low)}–$${number4.format(high)}`;
  }

  function buildPoolPrices(pools) {
    if (!Array.isArray(pools)) return {};
    return Object.fromEntries(
      pools
        .filter((pool) => pool.asset && pool.asset_tor_price)
        .map((pool) => [pool.asset.toUpperCase(), amountFromBase(pool.asset_tor_price)])
    );
  }

  function denomToPoolAsset(denom) {
    if (!denom) return '';
    if (denom === 'rune') return 'THOR.RUNE';
    if (denom.startsWith('x/ghost-vault/')) {
      return denomToPoolAsset(denom.slice('x/ghost-vault/'.length));
    }
    if (denom.startsWith('x/')) return `THOR.${denom.slice(2).toUpperCase()}`;
    if (denom.startsWith('thor.')) return denom.toUpperCase();
    if (!denom.includes('-')) return `THOR.${denom.toUpperCase()}`;
    const splitAt = denom.indexOf('-');
    return `${denom.slice(0, splitAt).toUpperCase()}.${denom.slice(splitAt + 1).toUpperCase()}`;
  }

  function assetUsdPrice(denom) {
    if (denom === 'rune') return runePriceUsd;
    const poolPrice = poolPrices[denomToPoolAsset(denom)];
    if (poolPrice) return poolPrice;
    if (isStableDenom(denom)) return 1;
    return 0;
  }

  function estimateUsd(balance) {
    return amountFromBase(balance.amount) * assetUsdPrice(balance.denom);
  }

  function isStableDenom(denom) {
    return /(?:usdc|usdt|dai|gusd|usdp)/i.test(denom || '');
  }

  function formatAssetAmount(balance) {
    const amount = amountFromBase(balance.amount);
    if (amount >= 1000) return number2.format(amount);
    if (amount >= 1) return number4.format(amount);
    return amount.toLocaleString('en-US', { maximumFractionDigits: 8 });
  }

  function collectorRevenueDisplay(summary) {
    if (artifactsLoading) return '—';
    if (summary.pricedUsd > 0) return usd2.format(summary.pricedUsd);
    if (summary.unpricedAssetCount > 0) return 'unpriced';
    return '$0.00';
  }

  function collectorRevenueNote(summary) {
    if (artifactsLoading) return 'loading all-time receipts';
    const pieces = [];
    if (summary.distributionTxCount) {
      pieces.push(`${summary.distributionTransferCount} distributed transfers`);
    }
    const residualAssets = (summary.assets || []).filter((asset) => asset.currentAmount > 0).length;
    if (residualAssets) pieces.push(`${residualAssets} current residual denoms`);
    if (summary.unpricedAssetCount) {
      pieces.push(`${formatUnpricedAssets(summary.assets)} unpriced`);
    }
    return pieces.join(' · ') || 'no all-time receipts found';
  }

  function targetRouteRevenue(summary, target) {
    return (summary.distributionRoutes || []).find((route) => route.recipient === target.address);
  }

  function targetRouteRevenueDisplay(summary, target) {
    if (artifactsLoading) return '—';
    const route = targetRouteRevenue(summary, target);
    if (route?.pricedUsd > 0) return usd2.format(route.pricedUsd);
    if (route?.unpricedAssetCount > 0) return 'unpriced';
    return '$0.00';
  }

  function formatUnpricedAssets(assets) {
    const unpriced = (assets || [])
      .filter((asset) => asset.priceUsd === 0 && asset.amount > 0)
      .slice(0, 2)
      .map((asset) => `${formatRevenueAmount(asset.amount)} ${formatDenom(asset.denom)}`);
    const remaining = Math.max(0, (assets || []).filter((asset) => asset.priceUsd === 0 && asset.amount > 0).length - 2);
    return `${unpriced.join(', ')}${remaining ? ` +${remaining} more` : ''}`;
  }

  function formatRevenueAmount(amount) {
    if (amount >= 1000) return number2.format(amount);
    if (amount >= 1) return number4.format(amount);
    return amount.toLocaleString('en-US', { maximumFractionDigits: 8 });
  }

  function formatWeekLabel(value) {
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime())) return value;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function formatDateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    });
  }

  function formatAddress(address) {
    if (!address) return '';
    return `${address.slice(0, 10)}…${address.slice(-6)}`;
  }

  function formatTxId(txId) {
    if (!txId) return '';
    return `${txId.slice(0, 8)}…${txId.slice(-6)}`;
  }

  function formatDenom(denom) {
    return (denom || '').toUpperCase();
  }

  function addressUrl(address) {
    return `${THORCHAIN_NET_BASE}/address/${address}`;
  }

  function txUrl(txId) {
    return `${THORCHAIN_NET_BASE}/tx/${txId}`;
  }

  function summarizeHistory(rows) {
    if (!rows.length) return 'history unavailable';
    return rows
      .map((row) => `${row.operation?.includes('INIT') ? 'init' : 'migrate'}:${row.code_id}`)
      .join(' → ');
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }
</script>

<section class="terminal">
  <div class="head">
    <div class="head-top">
      <div class="head-left">
        <span class="prompt">$</span>
        <span class="cmd">track</span>
        <span class="arg">--app-layer → --base-layer</span>
      </div>
      <div class="head-right">
        <span class="status">
          <span class="dot" class:warn={liveError} class:ok={!liveError && !liveLoading}></span>
          {liveError ? 'DEGRADED' : liveLoading ? 'SYNCING' : 'LIVE'}
        </span>
        <span class="sep">│</span>
        <button class="refresh" on:click={refreshLiveState} disabled={liveLoading}>
          <span class="bracket">[</span><span class="key">R</span><span class="bracket">]</span>
          {liveLoading ? 'refreshing' : 'refresh'}
        </button>
      </div>
    </div>
    <h1 class="title">APP LAYER <span class="arrow">→</span> BASE LAYER<span class="cursor">_</span></h1>
    <p class="lede">
      Rujira collector routes, observed final Reserve deposits, generated base-layer swap fees,
      and live Base Layer collector state. Reads `rujira-revenue` contract configs and THORNode
      swap fee events.
    </p>
    <div class="rule"></div>
  </div>

  {#if artifactsError || reservePaymentsError || reservePaymentsWarning || generatedFeesError || generatedFeesWarning || liveError || liveRouteWarning}
    <div class="alerts">
      {#if artifactsError}
        <div class="alert err">
          <span class="alert-tag">ERR</span>
          <span>artifact data — {artifactsError}</span>
        </div>
      {/if}
      {#if generatedFeesError}
        <div class="alert warn">
          <span class="alert-tag">WRN</span>
          <span>{generatedFeesError}</span>
        </div>
      {/if}
      {#if reservePaymentsError}
        <div class="alert warn">
          <span class="alert-tag">WRN</span>
          <span>{reservePaymentsError}</span>
        </div>
      {/if}
      {#if reservePaymentsWarning}
        <div class="alert warn">
          <span class="alert-tag">WRN</span>
          <span>{reservePaymentsWarning}</span>
        </div>
      {/if}
      {#if generatedFeesWarning}
        <div class="alert warn">
          <span class="alert-tag">WRN</span>
          <span>{generatedFeesWarning}</span>
        </div>
      {/if}
      {#if liveError}
        <div class="alert warn">
          <span class="alert-tag">WRN</span>
          <span>live state — {liveError}</span>
        </div>
      {/if}
      {#if liveRouteWarning}
        <div class="alert warn">
          <span class="alert-tag">WRN</span>
          <span>{liveRouteWarning}</span>
        </div>
      {/if}
    </div>
  {/if}

  <div class="metric-grid">
    <article class="metric">
      <div class="metric-head">
        <span class="metric-idx">01</span>
        <span class="metric-label">paid to tc reserve</span>
      </div>
      <strong class="metric-value">{reservePaymentsLoading && !weeklyRows.length ? '—' : usd2.format(latestWeek?.cumulative_usd || 0)}</strong>
      <small class="metric-foot">{number2.format(latestWeek?.cumulative_rune || 0)} RUNE · USD at dispersal</small>
    </article>
    <article class="metric">
      <div class="metric-head">
        <span class="metric-idx">02</span>
        <span class="metric-label">generated base fees</span>
      </div>
      <strong class="metric-value">
        {generatedFeesLoading && !generatedFeeRows.length ? '—' : usd2.format(totalGeneratedFeeUsd)}
      </strong>
      <small class="metric-foot">{number4.format(totalGeneratedFeeRune)} RUNE liquidity fees</small>
    </article>
    <article class="metric">
      <div class="metric-head">
        <span class="metric-idx">03</span>
        <span class="metric-label">reserve deposits</span>
      </div>
      <strong class="metric-value">{reservePaymentsLoading && !reserveEvents.length ? '—' : number2.format(meta?.eventCount || 0)}</strong>
      <small class="metric-foot">{number2.format(meta?.fetchedBlockCount || 0)} blocks scanned · {reservePaymentBackfillLabel}</small>
    </article>
    <article class="metric">
      <div class="metric-head">
        <span class="metric-idx">04</span>
        <span class="metric-label">known pending usd</span>
      </div>
      <strong class="metric-value">{liveLoading ? '—' : usd2.format(pendingKnownUsd)}</strong>
      <small class="metric-foot">{number2.format(pendingRune)} RUNE + {usd2.format(stableUsd)} stables</small>
    </article>
    <article class="metric">
      <div class="metric-head">
        <span class="metric-idx">05</span>
        <span class="metric-label">base layer share</span>
      </div>
      <strong class="metric-value">
        {liveLoading ? '—' : `${baseShares.trade.toFixed(0)}% / ${baseShares.core.toFixed(0)}%`}
      </strong>
      <small class="metric-foot">trade / core apps to base layer</small>
    </article>
  </div>

  <section class="block">
    <div class="block-head">
      <div class="block-title">
        <span class="title-marker">▌</span>
        <h2>observed reserve payments</h2>
      </div>
      <div class="block-meta">
        {#if firstEvent && latestEvent}
          [{formatWeekLabel(firstEvent.date.slice(0, 10))} → {formatWeekLabel(latestEvent.date.slice(0, 10))}]
        {:else}
          [loading range]
        {/if}
      </div>
    </div>
    <p class="block-lede">
      Weekly USD paid by the Base Layer collector to TC Reserve, priced when each Reserve deposit
      happened. This is RUNE sent × historical RUNE/USD at dispersal time, not the current value
      of that RUNE. The backend now uses the BooneTools Dune reserve-payment source query for
      this stream.
    </p>
    <div class="chart-frame">
      {#if reservePaymentsLoading && !weeklyRows.length}
        <div class="loading-block">
          <span class="loading-marker">▓░░░░</span>
          <span>loading reserve-payment stream</span>
        </div>
      {:else if !weeklyRows.length}
        <div class="loading-block">
          <span class="loading-marker">░░░░░</span>
          <span>no reserve-payment rows available</span>
        </div>
      {:else}
        <canvas bind:this={paymentCanvas} aria-label="Weekly and cumulative Base Layer Reserve payments"></canvas>
      {/if}
    </div>
    {#if weeklyRows.length}
      <div class="reserve-price-basis">
        <span>price basis</span>
        <strong>{reservePriceBasis}</strong>
        <span>observed range</span>
        <strong>{reservePriceRange || '—'} RUNE/USD</strong>
        <span>latest week avg</span>
        <strong>{latestReservePrice ? `$${number4.format(latestReservePrice)}` : '—'} RUNE/USD</strong>
      </div>
      <div class="table-scroll reserve-weekly-table">
        <table>
          <thead>
            <tr>
              <th>week</th>
              <th>deposits</th>
              <th>rune sent</th>
              <th>avg rune/usd</th>
              <th>usd at dispersal</th>
              <th>cumulative usd</th>
            </tr>
          </thead>
          <tbody>
            {#each weeklyRows as row}
              <tr>
                <td class="mono">{formatWeekLabel(row.week_start)} → {formatWeekLabel(row.week_end)}</td>
                <td class="num">{number2.format(row.payments || 0)}</td>
                <td class="num">{number2.format(row.payment_rune || 0)}</td>
                <td class="num">{row.rune_price_usd ? `$${number4.format(row.rune_price_usd)}` : '—'}</td>
                <td class="num accent">{usd2.format(row.payment_usd || 0)}</td>
                <td class="num accent">{usd2.format(row.cumulative_usd || 0)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <section class="block">
    <div class="block-head">
      <div class="block-title">
        <span class="title-marker blue">▌</span>
        <h2>generated base-layer fees</h2>
      </div>
      <div class="block-meta">
        {#if generatedFeeMeta}
          [{number2.format(generatedFeeMeta.matchedSwapFeeEventCount || 0)} swap events]
        {:else}
          [pending scan]
        {/if}
      </div>
    </div>
    <p class="block-lede">
      Dune-indexed Rujira WASM context joined to THORChain swap fees from Rujira
      contract-triggered base-layer swaps, displayed separately from explicit Reserve payments.
      Current scan scope: {generatedFeeScope}
    </p>

    <div class="generated-layout">
      <div class="chart-frame">
        {#if generatedFeesLoading && !generatedFeeRows.length}
          <div class="loading-block">
            <span class="loading-marker">▓░░░░</span>
            <span>loading generated-fee scan</span>
          </div>
        {:else if !generatedFeeRows.length}
          <div class="loading-block">
            <span class="loading-marker">░░░░░</span>
            <span>no generated-fee rows available</span>
          </div>
        {:else}
          <canvas bind:this={generatedFeesCanvas} aria-label="Weekly and cumulative generated base-layer fees"></canvas>
        {/if}
      </div>

      <div class="impact-panel">
        <div class="impact-card">
          <span>generated fees</span>
          <strong>{usd2.format(totalGeneratedFeeUsd)}</strong>
          <small>{number4.format(totalGeneratedFeeRune)} RUNE</small>
        </div>
        <div class="impact-card">
          <span>active heights</span>
          <strong>{number2.format(generatedFeeMeta?.activeHeightCount || 0)}</strong>
          <small>{number2.format(generatedFeeMeta?.matchedSwapFeeEventCount || 0)} matched swap events · {generatedFeeBackfillLabel}</small>
        </div>
        <div class="table-scroll route-table">
          <table>
            <thead>
              <tr>
                <th>route</th>
                <th>events</th>
                <th>fee rune</th>
                <th>fee usd</th>
              </tr>
            </thead>
            <tbody>
              {#each topGeneratedFeeRoutes as route}
                <tr>
                  <td class="mono ellipsis" title={route.source_contract || route.source_denom || route.classification}>
                    {route.source_label || route.source_denom || route.classification}
                  </td>
                  <td class="num">{number2.format(route.swap_events || 0)}</td>
                  <td class="num">{number4.format(route.liquidity_fee_rune || 0)}</td>
                  <td class="num accent-blue">{usd2.format(route.liquidity_fee_usd || 0)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="scope-note">{generatedFeeMeta?.caveat || 'Generated-fee scan is being prepared.'}</p>
      </div>
    </div>
  </section>

  <section class="block">
    <div class="block-head">
      <div class="block-title">
        <span class="title-marker">▌</span>
        <h2>current revenue routes</h2>
      </div>
      <div class="block-meta">
        {#if lastLiveRefresh}
          [refresh {formatDateTime(lastLiveRefresh)}]
        {:else}
          [pending refresh]
        {/if}
      </div>
    </div>
    <p class="block-lede">
      Live <span class="inline-code">rujira-revenue</span> target addresses. Base Layer routes
      highlighted green. Collector values are all-time distributions plus current residual balances,
      priced with THORNode pool prices plus Rujira app-asset prices and receipt-token NAVs.
    </p>

    <div class="flow">
      <div class="flow-col">
        <div class="col-head">app collectors</div>
        {#each appCollectorRows as collector, i}
          <article class="node">
            <div class="node-head">
              <span class="node-idx">{pad2(i + 1)}</span>
              <a
                class="node-title-link"
                href={addressUrl(collector.address)}
                target="_blank"
                rel="noopener noreferrer"
                title={collector.address}
              >{collector.name}</a>
              <span class="node-pill" class:hot={baseShares[collector.key] > 0}>
                {baseShares[collector.key].toFixed(0)}% → base
              </span>
            </div>
            <p class="node-role">
              {collector.role}
              <a
                class="addr-link"
                href={addressUrl(collector.address)}
                target="_blank"
                rel="noopener noreferrer"
                title={collector.address}
              >{formatAddress(collector.address)}</a>
            </p>
            <div class="node-value">
              <span>all-time collected</span>
              <strong>{collectorRevenueDisplay(collector.revenueSummary)}</strong>
              <small>{collectorRevenueNote(collector.revenueSummary)}</small>
            </div>
            <div class="targets">
              {#each targetMap[collector.key] as target}
                <div class="target" class:on-base={target.address === BASE_LAYER_COLLECTOR}>
                  <span class="target-arrow">→</span>
                  <a
                    class="target-name"
                    href={addressUrl(target.address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={target.address}
                  >{target.label}</a>
                  <span class="target-usd">{targetRouteRevenueDisplay(collector.revenueSummary, target)}</span>
                  <b class="target-pct">{target.percent.toFixed(0)}%</b>
                </div>
              {/each}
            </div>
          </article>
        {/each}
      </div>

      <div class="flow-col flow-mid">
        <div class="col-head accent">base layer queue</div>
        <article class="node primary">
          <div class="node-head">
            <span class="node-idx">▣</span>
            <strong>Base Layer Collector</strong>
            <span class="node-pill code">code {latestCodeIds.base}</span>
          </div>
          <p class="node-role mono">
            <a
              class="addr-link"
              href={addressUrl(BASE_LAYER_COLLECTOR)}
              target="_blank"
              rel="noopener noreferrer"
              title={BASE_LAYER_COLLECTOR}
            >{formatAddress(BASE_LAYER_COLLECTOR)}</a>
          </p>
          <div class="queue">
            <div>
              <span>rune</span>
              <strong>{number2.format(pendingRune)}</strong>
            </div>
            <div>
              <span>rune usd</span>
              <strong>{usd2.format(pendingRuneUsd)}</strong>
            </div>
            <div>
              <span>stables</span>
              <strong>{usd2.format(stableUsd)}</strong>
            </div>
          </div>
          <div class="targets">
            {#each targetMap.base as target}
              <div class="target on-base">
                <span class="target-arrow">→</span>
                <a
                  class="target-name"
                  href={addressUrl(target.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={target.address}
                >{target.label}</a>
                <b class="target-pct">{target.percent.toFixed(0)}%</b>
              </div>
            {/each}
          </div>
        </article>
      </div>

      <div class="flow-col">
        <div class="col-head">destination</div>
        <article class="node reserve">
          <div class="node-head">
            <span class="node-idx">◈</span>
            <strong>TC Reserve</strong>
            <span class="node-pill amber">RESERVE memo</span>
          </div>
          <p class="node-role mono">
            <a
              class="addr-link"
              href={addressUrl(RESERVE_MODULE)}
              target="_blank"
              rel="noopener noreferrer"
              title={RESERVE_MODULE}
            >{formatAddress(RESERVE_MODULE)}</a>
          </p>
          <div class="reserve-total">
            <span>historical usd at dispersal</span>
            <strong>{usd2.format(latestWeek?.cumulative_usd || 0)}</strong>
          </div>
        </article>
        <article class="node muted">
          <div class="node-head">
            <span class="node-idx">!</span>
            <strong>System income note</strong>
          </div>
          <p class="node-role">
            Midgard system income = liquidity fees + block rewards. These Reserve deposits are
            <em>not</em> included in that line item.
          </p>
        </article>
      </div>
    </div>
  </section>

  <div class="split">
    <article class="block">
      <div class="block-head">
        <div class="block-title">
          <span class="title-marker">▌</span>
          <h2>collector balances</h2>
        </div>
        <div class="block-meta">[{topBalances.length} denoms]</div>
      </div>
      <p class="block-lede">USD estimated for RUNE and stable denoms only.</p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>denom</th>
              <th>amount</th>
              <th>est. usd</th>
            </tr>
          </thead>
          <tbody>
            {#each topBalances as balance}
              <tr>
                <td class="mono ellipsis" title={balance.denom}>{balance.denom}</td>
                <td class="num">{balance.amountDisplay}</td>
                <td class="num accent">{balance.usdValue ? usd2.format(balance.usdValue) : '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </article>

    <article class="block">
      <div class="block-head">
        <div class="block-title">
          <span class="title-marker">▌</span>
          <h2>latest reserve deposits</h2>
        </div>
        <div class="block-meta">[{recentEvents.length} events]</div>
      </div>
      <p class="block-lede">Most recent observed final deposits from the event scan, priced at the historical RUNE/USD rate for the deposit date.</p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>time</th>
              <th>height</th>
              <th>tx</th>
              <th>rune</th>
              <th>rune/usd</th>
              <th>usd sent</th>
            </tr>
          </thead>
          <tbody>
            {#each recentEvents as event}
              <tr>
                <td class="mono">{formatDateTime(event.date)}</td>
                <td class="num">{event.height}</td>
                <td class="num">
                  <a class="table-link" href={txUrl(event.id)} target="_blank" rel="noopener noreferrer" title={event.id}>
                    {formatTxId(event.id)}
                  </a>
                </td>
                <td class="num accent">{number4.format(event.amountRune)}</td>
                <td class="num">{event.runePriceUsd ? `$${number4.format(event.runePriceUsd)}` : '—'}</td>
                <td class="num accent">{event.amountUsd ? usd2.format(event.amountUsd) : '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </article>
  </div>

  <section class="block">
    <div class="block-head">
      <div class="block-title">
        <span class="title-marker">▌</span>
        <h2>version path</h2>
      </div>
      <div class="block-meta">[{versionTimeline.length} events]</div>
    </div>
    <p class="block-lede">
      Historical points that explain why allocation existed earlier than observed Reserve payments.
    </p>
    <ol class="timeline">
      {#each versionTimeline as item, i}
        <li>
          <div class="t-idx">{pad2(i + 1)}</div>
          <div class="t-rail">
            <span class="t-node"></span>
            {#if i < versionTimeline.length - 1}<span class="t-line"></span>{/if}
          </div>
          <div class="t-body">
            <span class="t-date">{item.date}</span>
            <strong class="t-collector">{item.collector}</strong>
            <b class="t-event">{item.event}</b>
            <p class="t-flow">{item.flow}</p>
          </div>
        </li>
      {/each}
    </ol>
  </section>

  <div class="split">
    <article class="block">
      <div class="block-head">
        <div class="block-title">
          <span class="title-marker">▌</span>
          <h2>contract history</h2>
        </div>
        <div class="block-meta">[{collectors.length} collectors]</div>
      </div>
      <p class="block-lede">Live code history for the current `rujira-revenue` contracts.</p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>collector</th>
              <th>history</th>
            </tr>
          </thead>
          <tbody>
            {#each collectors as collector}
              <tr>
                <td>
                  <a
                    class="table-link"
                    href={addressUrl(collector.address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={collector.address}
                  >{collector.name}</a>
                </td>
                <td class="mono">{historyLabels[collector.key]}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </article>

    <article class="block">
      <div class="block-head">
        <div class="block-title">
          <span class="title-marker">▌</span>
          <h2>similar contracts</h2>
        </div>
        <div class="block-meta">[{similarContracts.length} checked]</div>
      </div>
      <p class="block-lede">Same or similar revenue code contracts that did not target TC Reserve.</p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>label</th>
              <th>code</th>
              <th>target</th>
            </tr>
          </thead>
          <tbody>
            {#each similarContracts as contract}
              <tr>
                <td>
                  <a
                    class="table-link"
                    href={addressUrl(contract.address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={contract.address}
                  >{contract.label}</a>
                </td>
                <td class="num">{contract.codeId}</td>
                <td>{contract.target}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </article>
  </div>

  <footer class="foot">
    <div class="foot-line">
      <span class="foot-tag">artifacts</span>
      <span>{meta?.generatedAt ? formatDateTime(meta.generatedAt) : 'loading'}</span>
    </div>
    <div class="foot-line">
      <span class="foot-tag">path</span>
      <span class="mono">
        <a href={addressUrl(BASE_LAYER_COLLECTOR)} target="_blank" rel="noopener noreferrer">Base Layer Collector</a>
        → <a href={addressUrl(RESERVE_MODULE)} target="_blank" rel="noopener noreferrer">TC Reserve</a>
        via MsgDeposit RESERVE
      </span>
    </div>
  </footer>
</section>

<style>
  .terminal {
    width: min(1380px, calc(100vw - 24px));
    margin: 0 auto;
    padding: 24px 0 56px;
    color: #c8c8c8;
    font-family: 'DM Sans', -apple-system, sans-serif;
    font-size: 13px;
    line-height: 1.5;
  }

  .terminal h1,
  .terminal h2,
  .terminal p,
  .terminal strong,
  .terminal b,
  .terminal small {
    margin: 0;
  }

  /* ========== HEAD ========== */

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
    color: #c8c8c8;
    font-weight: 600;
  }

  .arg {
    color: #666;
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
    color: #888;
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
    box-shadow: 0 0 6px rgba(212, 160, 23, 0.4);
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }

  .sep {
    color: #1a1a1a;
  }

  .refresh {
    display: inline-flex;
    align-items: center;
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

  .bracket {
    color: #333;
  }

  .key {
    color: #00cc66;
    font-weight: 700;
  }

  .title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 30px;
    font-weight: 800;
    color: #e8e8e8;
    letter-spacing: 0.06em;
    line-height: 1.1;
    margin-bottom: 10px;
  }

  .title .arrow {
    color: #00cc66;
    margin: 0 4px;
  }

  .cursor {
    color: #00cc66;
    animation: blink 1s steps(1) infinite;
    margin-left: 4px;
  }

  @keyframes blink {
    0%, 50% { opacity: 1; }
    50.01%, 100% { opacity: 0; }
  }

  .lede {
    color: #888;
    font-size: 13px;
    max-width: 820px;
  }

  .rule {
    height: 1px;
    background: linear-gradient(
      90deg,
      #00cc66 0%,
      #1a1a1a 14%,
      #1a1a1a 100%
    );
    margin-top: 16px;
  }

  /* ========== ALERTS ========== */

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

  /* ========== METRIC GRID ========== */

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 1px;
    border: 1px solid #1a1a1a;
    background: #1a1a1a;
    margin-bottom: 18px;
  }

  .metric {
    padding: 16px 18px;
    background: #0a0a0a;
    border-right: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 116px;
    transition: background 0.15s;
  }

  .metric:last-child {
    border-right: none;
  }

  .metric:hover {
    background: #0d0d0d;
  }

  .metric-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
  }

  .metric-idx {
    color: #00cc66;
    font-weight: 700;
  }

  .metric-label {
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-weight: 600;
  }

  .metric-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 24px;
    font-weight: 800;
    color: #e8e8e8;
    letter-spacing: -0.01em;
    line-height: 1.1;
    overflow-wrap: anywhere;
    margin-top: auto;
  }

  .metric-foot {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #555;
  }

  /* ========== BLOCK ========== */

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

  .title-marker {
    color: #00cc66;
    font-size: 16px;
    line-height: 1;
  }

  .title-marker.blue {
    color: #44a0ff;
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

  .block-lede {
    color: #777;
    font-size: 12px;
    margin-bottom: 16px;
    line-height: 1.5;
  }

  .inline-code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 1px 5px;
    background: #111;
    color: #00cc66;
    border: 1px solid #1a1a1a;
  }

  /* ========== CHART ========== */

  .chart-frame {
    height: 360px;
    background: #080808;
    border: 1px solid #111;
    padding: 12px;
  }

  .chart-frame canvas {
    width: 100%;
    height: 100%;
  }

  .reserve-price-basis {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 6px 12px;
    margin-top: 12px;
    padding: 10px 12px;
    background: #080808;
    border: 1px solid #111;
    font-family: 'JetBrains Mono', monospace;
  }

  .reserve-price-basis span {
    color: #555;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .reserve-price-basis strong {
    color: #b8b8b8;
    font-size: 10px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .reserve-weekly-table {
    margin-top: 12px;
  }

  .reserve-weekly-table table {
    min-width: 760px;
  }

  .generated-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.8fr);
    gap: 14px;
    align-items: stretch;
  }

  .generated-layout .chart-frame {
    height: 390px;
  }

  .impact-panel {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    align-content: start;
  }

  .impact-card {
    background: #080808;
    border: 1px solid #141414;
    border-left: 2px solid #44a0ff;
    padding: 12px 14px;
    min-height: 92px;
  }

  .impact-card span {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    margin-bottom: 8px;
  }

  .impact-card strong {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 18px;
    color: #e8e8e8;
    font-weight: 800;
    line-height: 1.1;
    overflow-wrap: anywhere;
  }

  .impact-card small {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #44a0ff;
    margin-top: 7px;
  }

  .route-table,
  .scope-note {
    grid-column: 1 / -1;
  }

  .table-scroll.route-table {
    overflow-x: hidden;
  }

  .route-table table {
    min-width: 0;
    table-layout: fixed;
  }

  .route-table th,
  .route-table td {
    padding-left: 6px;
    padding-right: 6px;
  }

  .route-table th {
    letter-spacing: 0.08em;
  }

  .route-table th:first-child,
  .route-table td:first-child {
    width: 46%;
  }

  .route-table th:nth-child(2),
  .route-table td:nth-child(2) {
    width: 15%;
  }

  .route-table th:nth-child(3),
  .route-table td:nth-child(3) {
    width: 19%;
  }

  .route-table th:nth-child(4),
  .route-table td:nth-child(4) {
    width: 20%;
  }

  .scope-note {
    margin: 0;
    color: #666;
    font-size: 11px;
    line-height: 1.45;
    border-top: 1px dashed #1a1a1a;
    padding-top: 10px;
  }

  .loading-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    height: 100%;
    color: #555;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .loading-marker {
    color: #00cc66;
    font-size: 14px;
    animation: marquee 1.2s steps(5) infinite;
  }

  @keyframes marquee {
    0% { opacity: 0.3; }
    50% { opacity: 1; }
    100% { opacity: 0.3; }
  }

  /* ========== FLOW ========== */

  .flow {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr) minmax(0, 0.95fr);
    gap: 0;
    border-top: 1px solid #141414;
  }

  .flow-col {
    padding: 14px 14px 4px;
    border-right: 1px solid #141414;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .flow-col:last-child {
    border-right: none;
  }

  .flow-col.flow-mid {
    background: rgba(0, 204, 102, 0.02);
  }

  .col-head {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 700;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    padding-bottom: 8px;
    border-bottom: 1px dashed #1a1a1a;
  }

  .col-head.accent {
    color: #00cc66;
  }

  .node {
    border: 1px solid #1a1a1a;
    padding: 12px 14px;
    background: #0d0d0d;
  }

  .node.primary {
    border-color: rgba(0, 204, 102, 0.45);
    background: linear-gradient(180deg, rgba(0, 204, 102, 0.07) 0%, #0a0a0a 60%);
    box-shadow: inset 0 0 18px rgba(0, 204, 102, 0.04);
  }

  .node.reserve {
    border-color: rgba(212, 160, 23, 0.4);
    background: linear-gradient(180deg, rgba(212, 160, 23, 0.06) 0%, #0a0a0a 60%);
  }

  .node.muted {
    background: #080808;
    border-color: #141414;
  }

  .node-head {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 4px;
    flex-wrap: wrap;
  }

  .node-idx {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #00cc66;
    font-weight: 700;
    min-width: 14px;
  }

  .node-head strong,
  .node-title-link {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: #e0e0e0;
    font-weight: 700;
    flex: 1;
    min-width: 0;
  }

  .node-title-link,
  .addr-link,
  .target-name,
  .table-link,
  .foot a {
    text-decoration: none;
    transition: color 0.15s, border-color 0.15s;
  }

  .node-title-link:hover,
  .addr-link:hover,
  .target-name:hover,
  .table-link:hover,
  .foot a:hover {
    color: #00cc66;
  }

  .node-pill {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 600;
    padding: 2px 7px;
    border: 1px solid #1a1a1a;
    background: #050505;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    white-space: nowrap;
  }

  .node-pill.hot {
    border-color: rgba(0, 204, 102, 0.4);
    color: #00cc66;
  }

  .node-pill.code {
    color: #888;
  }

  .node-pill.amber {
    border-color: rgba(212, 160, 23, 0.4);
    color: #d4a017;
  }

  .node-role {
    color: #666;
    font-size: 11px;
    margin: 4px 0 10px;
    line-height: 1.45;
  }

  .node-role.mono {
    font-family: 'JetBrains Mono', monospace;
    color: #888;
  }

  .addr-link {
    color: #888;
    font-family: 'JetBrains Mono', monospace;
    margin-left: 6px;
    border-bottom: 1px dotted #2a2a2a;
  }

  .node-role.mono .addr-link {
    margin-left: 0;
  }

  .node-value {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 8px;
    align-items: baseline;
    margin: 8px 0 10px;
    padding: 8px 10px;
    background: #060606;
    border-left: 2px solid #1a1a1a;
  }

  .node-value span {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  .node-value strong {
    justify-self: end;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    color: #d8d8d8;
    font-weight: 700;
  }

  .node-value small {
    grid-column: 1 / -1;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #666;
    overflow-wrap: anywhere;
  }

  .targets {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .target {
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr) auto auto;
    gap: 8px;
    align-items: baseline;
    padding: 6px 8px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #888;
    background: #060606;
    border-left: 2px solid #1a1a1a;
  }

  .target-arrow {
    color: #333;
  }

  .target-name {
    color: inherit;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .target-usd {
    color: #c8c8c8;
    font-weight: 700;
    white-space: nowrap;
  }

  .target-pct {
    color: #c8c8c8;
    font-weight: 600;
  }

  .target.on-base {
    border-left-color: #00cc66;
    background: rgba(0, 204, 102, 0.05);
    color: #b8e8c8;
  }

  .target.on-base .target-arrow {
    color: #00cc66;
  }

  .target.on-base .target-pct {
    color: #00cc66;
  }

  .target.on-base .target-usd {
    color: #00cc66;
  }

  .queue {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    margin: 10px 0;
    border-top: 1px dashed #1a1a1a;
    border-bottom: 1px dashed #1a1a1a;
    padding: 8px 0;
  }

  .queue div {
    text-align: left;
    padding: 0 4px;
  }

  .queue span {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    margin-bottom: 4px;
  }

  .queue strong {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: #00cc66;
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .reserve-total {
    margin-top: 8px;
    padding: 10px 12px;
    background: rgba(212, 160, 23, 0.05);
    border-left: 2px solid #d4a017;
  }

  .reserve-total span {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: #777;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    margin-bottom: 4px;
  }

  .reserve-total strong {
    font-family: 'JetBrains Mono', monospace;
    font-size: 16px;
    color: #d4a017;
    font-weight: 700;
  }

  /* ========== SPLIT ========== */

  .split {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    margin-bottom: 14px;
  }

  /* ========== TABLES ========== */

  .table-scroll {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 480px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
  }

  th,
  td {
    padding: 8px 8px;
    text-align: left;
    vertical-align: top;
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
  }

  td {
    color: #b8b8b8;
  }

  td.mono {
    color: #888;
  }

  td.num,
  td:nth-child(n + 2),
  th:nth-child(n + 2) {
    text-align: right;
  }

  td.accent {
    color: #00cc66;
  }

  td.accent-blue {
    color: #44a0ff;
  }

  .table-link {
    color: #b8b8b8;
    border-bottom: 1px dotted #2a2a2a;
  }

  td.ellipsis {
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  tbody tr:hover {
    background: #0d0d0d;
  }

  tbody tr:hover td.accent {
    color: #2ee080;
  }

  /* ========== TIMELINE ========== */

  .timeline {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .timeline li {
    display: grid;
    grid-template-columns: 30px 18px 1fr;
    gap: 10px;
    padding: 12px 0;
    border-bottom: 1px dashed #141414;
  }

  .timeline li:last-child {
    border-bottom: none;
  }

  .t-idx {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #444;
    padding-top: 4px;
    font-weight: 700;
  }

  .t-rail {
    position: relative;
    display: flex;
    justify-content: center;
  }

  .t-node {
    width: 8px;
    height: 8px;
    border: 1px solid #00cc66;
    background: #050505;
    margin-top: 5px;
    flex-shrink: 0;
    z-index: 1;
  }

  .t-line {
    position: absolute;
    top: 13px;
    bottom: -12px;
    width: 1px;
    background: #1a1a1a;
  }

  .t-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .t-date {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #00cc66;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .t-collector {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: #e0e0e0;
    font-weight: 700;
  }

  .t-event {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #d4a017;
    font-weight: 600;
  }

  .t-flow {
    color: #777;
    font-size: 12px;
    margin-top: 2px;
    line-height: 1.45;
  }

  /* ========== FOOT ========== */

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
  }

  .foot-line {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .foot-tag {
    color: #333;
    text-transform: uppercase;
    letter-spacing: 0.14em;
  }

  .foot .mono {
    color: #777;
  }

  .foot a {
    color: #888;
    border-bottom: 1px dotted #2a2a2a;
  }

  /* ========== RESPONSIVE ========== */

  @media (max-width: 1024px) {
    .metric-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .flow {
      grid-template-columns: 1fr;
    }

    .flow-col {
      border-right: none;
      border-bottom: 1px solid #141414;
    }

    .flow-col:last-child {
      border-bottom: none;
    }

    .split {
      grid-template-columns: 1fr;
    }

    .generated-layout {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 640px) {
    .terminal {
      width: calc(100vw - 16px);
      padding: 16px 0 40px;
    }

    .head-top {
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
    }

    .title {
      font-size: 22px;
    }

    .metric-grid {
      grid-template-columns: 1fr;
    }

    .metric {
      border-right: none;
    }

    .block {
      padding: 14px 14px 18px;
    }

    .chart-frame {
      height: 280px;
    }

    .generated-layout .chart-frame {
      height: 300px;
    }

    .impact-panel {
      grid-template-columns: 1fr;
    }

    .table-scroll.route-table {
      overflow-x: auto;
    }

    .route-table table {
      min-width: 480px;
      table-layout: auto;
    }
  }
</style>
