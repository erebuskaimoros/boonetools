<script>
  import { onMount } from 'svelte';
  import Chart from 'chart.js/auto';
  import zoomPlugin from 'chartjs-plugin-zoom';

  Chart.register(zoomPlugin);

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
      { label: 'RUJI Swap collector', address: collectors[2].address, percent: 50 },
      { label: 'Base Layer Collector', address: BASE_LAYER_COLLECTOR, percent: 50 }
    ],
    core: [
      { label: 'RUJI Swap collector', address: collectors[2].address, percent: 50 },
      { label: 'Base Layer Collector', address: BASE_LAYER_COLLECTOR, percent: 50 }
    ],
    swap: [{ label: 'RUJI staker collector', address: RUJI_STAKER_COLLECTOR, percent: 100 }],
    index: [{ label: 'RUJI Swap collector', address: collectors[2].address, percent: 100 }],
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

  const EMPTY_INVENTORY_BUCKET = Object.freeze({ rows: [], count: 0, pricedUsd: 0, unpricedCount: 0 });
  const EMPTY_INVENTORY = Object.freeze({
    available: false,
    actionsAvailable: false,
    eligible: EMPTY_INVENTORY_BUCKET,
    conversion: EMPTY_INVENTORY_BUCKET,
    blocked: EMPTY_INVENTORY_BUCKET,
    unresolved: EMPTY_INVENTORY_BUCKET,
    pricedUsd: 0
  });

  // Entity colors. Validated marks (dark-surface lightness band + CVD +
  // contrast) carry the chart geometry; the brighter chrome variants are for
  // page accents only.
  const SERIES = {
    collected: {
      mark: '#b8860b',
      fill: 'rgba(184, 134, 11, 0.5)',
      faint: 'rgba(184, 134, 11, 0.09)',
      chrome: '#d4a017'
    },
    paid: {
      mark: '#00a755',
      fill: 'rgba(0, 167, 85, 0.5)',
      faint: 'rgba(0, 167, 85, 0.09)',
      chrome: '#00cc66'
    },
    generated: {
      mark: '#2f7fd6',
      fill: 'rgba(47, 127, 214, 0.5)',
      faint: 'rgba(47, 127, 214, 0.09)',
      chrome: '#44a0ff'
    }
  };

  let weeklyRows = [];
  let reserveEvents = [];
  let staticWeeklyRows = [];
  let staticReserveEvents = [];
  let staticReserveMeta = null;
  let generatedFees = null;
  let staticGeneratedFees = null;
  let inflows = null;
  let meta = null;
  let configs = {};
  let histories = {};
  let balances = [];
  let collectorBalances = {};
  let collectorActions = {};
  let poolPrices = {};
  let runePriceUsd = 0;
  let reservePaymentsLoading = true;
  let generatedFeesLoading = true;
  let inflowsLoading = true;
  let liveLoading = true;
  let artifactsError = '';
  let reservePaymentsError = '';
  let reservePaymentsWarning = '';
  let generatedFeesError = '';
  let generatedFeesWarning = '';
  let inflowsError = '';
  let liveError = '';
  let liveRouteWarning = '';
  let lastLiveRefresh = null;

  let collectedCanvas;
  let collectedChart;
  let paymentCanvas;
  let paymentChart;
  let generatedFeesCanvas;
  let generatedFeesChart;

  // Two independent per-chart toggles: bucket size (daily default, weekly
  // option) and view (per-bucket bars vs cumulative line). The visible time
  // range is set directly on the chart by dragging or scrolling to zoom.
  let granularity = { collected: 'daily', paid: 'daily', generated: 'daily' };
  let view = { collected: 'bars', paid: 'bars', generated: 'bars' };
  let zoomed = { collected: false, paid: false, generated: false };

  function setGranularity(key, value) {
    granularity = { ...granularity, [key]: value };
    zoomed = { ...zoomed, [key]: false };
  }

  function setView(key, value) {
    view = { ...view, [key]: value };
    zoomed = { ...zoomed, [key]: false };
  }

  const chartByKey = () => ({
    collected: collectedChart,
    paid: paymentChart,
    generated: generatedFeesChart
  });

  function resetZoom(key) {
    chartByKey()[key]?.resetZoom();
    zoomed = { ...zoomed, [key]: false };
  }

  function markZoomed(key, active) {
    if (zoomed[key] !== active) zoomed = { ...zoomed, [key]: active };
  }

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
  const signedUsd2 = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
    signDisplay: 'always'
  });
  const number2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const number4 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
  const signedNumber4 = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 4,
    signDisplay: 'always'
  });

  function collectedFlowTooltip(row, grain, limit = 4) {
    const entries = Object.entries(row.by_denom || {}).sort(
      (a, b) => Math.abs(b[1].usd || 0) - Math.abs(a[1].usd || 0)
    );
    const shown = entries.slice(0, limit);
    const remaining = entries.slice(limit);
    const lines = [
      `${number2.format(row.transfers || 0)} ${grain === 'weekly' ? 'denom-day' : 'denom'} balance changes`,
      ...shown.map(
        ([denom, entry]) =>
          `${denomLabel(denom)}: ${signedNumber4.format(entry.amount)} · ${signedUsd2.format(entry.usd)}`
      )
    ];

    if (remaining.length) {
      const remainingUsd = remaining.reduce((sum, [, entry]) => sum + (entry.usd || 0), 0);
      lines.push(`${number2.format(remaining.length)} other net: ${signedUsd2.format(remainingUsd)}`);
    }

    return lines;
  }

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
    'price basis unavailable for this fallback artifact';
  $: reservePaymentSource = formatDataSource(reservePaymentMeta.source);
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
  $: generatedFeeSource = formatDataSource(generatedFeeMeta?.source);
  $: generatedFeeBackfillLabel = generatedFeeMeta?.backfillComplete
    ? 'backfill complete'
    : `${number2.format(Number(generatedFeeMeta?.pendingBlockCount || 0))} blocks queued`;

  // Total benefit to THORChain = 02 realized to the Reserve + 03 realized to
  // System Income. 01 accrued is excluded (it overlaps 02 by construction) and
  // so is pending inventory (not yet realized) — only these two are fresh,
  // non-overlapping value that actually reached the network.
  $: totalReservePaidUsd = latestWeek?.cumulative_usd || 0;
  $: totalBenefitUsd = totalReservePaidUsd + totalGeneratedFeeUsd;
  $: benefitReserveShare = totalBenefitUsd > 0 ? (totalReservePaidUsd / totalBenefitUsd) * 100 : 0;
  $: benefitLpShare = totalBenefitUsd > 0 ? (totalGeneratedFeeUsd / totalBenefitUsd) * 100 : 0;
  $: totalBenefitLoading =
    (reservePaymentsLoading && !weeklyRows.length) ||
    (generatedFeesLoading && !generatedFeeRows.length);

  $: inflowRows = inflows?.weekly || [];
  $: inflowMeta = inflows?.meta || null;
  $: inflowDenomTotals = (inflows?.denomTotals || [])
    .slice()
    .sort((a, b) => Math.abs(b.usd || 0) - Math.abs(a.usd || 0))
    .slice(0, 8);
  $: totalInflowUsd = inflowMeta?.totalInflowUsd || inflowRows.at(-1)?.cumulative_usd || 0;
  $: inflowOpeningUsd = Number(inflowMeta?.baselineInventoryUsd || 0);
  $: inflowNetNewUsd = Number(inflowMeta?.netNewInflowUsd || 0);
  $: inflowDayCount = Number(inflowMeta?.dayCount || 0);

  $: collectorInventories = Object.fromEntries(
    collectors.map((collector) => [
      collector.key,
      summarizeCollectorInventory(
        configs[collector.key],
        Object.prototype.hasOwnProperty.call(collectorBalances, collector.key)
          ? collectorBalances[collector.key]
          : null,
        collectorActions[collector.key]
      )
    ])
  );
  $: baseInventory = collectorInventories.base || EMPTY_INVENTORY;
  $: baseRoutableInventoryUsd = baseInventory.eligible.pricedUsd + baseInventory.conversion.pricedUsd;
  $: appCollectorInventoryUsd = collectors
    .filter((collector) => collector.key !== 'base')
    .reduce((sum, collector) => sum + (collectorInventories[collector.key]?.pricedUsd || 0), 0);
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
  $: upstreamBaseBoundUsd = ['trade', 'core'].reduce((sum, key) => {
    const inventory = collectorInventories[key] || EMPTY_INVENTORY;
    const routableUsd = inventory.eligible.pricedUsd + inventory.conversion.pricedUsd;
    return sum + routableUsd * ((baseShares[key] || 0) / 100);
  }, 0);
  $: pendingKnownUsd = baseRoutableInventoryUsd + upstreamBaseBoundUsd;
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
  $: baseRuneRatePerSecond = targetRatePerSecond(configs.base, 'rune');

  function renderCollectedChart(pick, chartView) {
    collectedChart = renderSeriesChart(collectedCanvas, collectedChart, {
      zoomKey: 'collected',
      rows: pick.rows,
      grain: pick.grain,
      view: chartView,
      colors: SERIES.collected,
      valueField: 'inflow_usd',
      cumulativeField: 'cumulative_usd',
      barLabel: 'App-layer earnings allocated to Base Layer',
      cumulativeLabel: 'Cumulative app-layer earnings allocated to Base Layer',
      afterBody: (row) => collectedFlowTooltip(row, pick.grain)
    });
  }

  function renderPaymentChart(pick, chartView) {
    paymentChart = renderSeriesChart(paymentCanvas, paymentChart, {
      zoomKey: 'paid',
      rows: pick.rows,
      grain: pick.grain,
      view: chartView,
      colors: SERIES.paid,
      valueField: 'payment_usd',
      cumulativeField: 'cumulative_usd',
      barLabel: 'Paid USD at deposit price',
      cumulativeLabel: 'Cumulative paid USD',
      afterBody: (row) => [
        `${number2.format(row.payments || 0)} deposit${row.payments === 1 ? '' : 's'}`,
        `${number2.format(row.payment_rune || 0)} RUNE paid`,
        `${number4.format(row.rune_price_usd || 0)} avg historical RUNE/USD`,
        `${number2.format(row.cumulative_rune || 0)} cumulative RUNE`
      ]
    });
  }

  function renderGeneratedFeesChart(pick, chartView) {
    generatedFeesChart = renderSeriesChart(generatedFeesCanvas, generatedFeesChart, {
      zoomKey: 'generated',
      rows: pick.rows,
      grain: pick.grain,
      view: chartView,
      colors: SERIES.generated,
      valueField: 'liquidity_fee_usd',
      cumulativeField: 'cumulative_usd',
      barLabel: 'Generated fees USD',
      cumulativeLabel: 'Cumulative generated fees USD',
      afterBody: (row) => [
        `${number4.format(row.liquidity_fee_rune || 0)} RUNE fees`,
        `${number4.format(row.rune_price_usd || 0)} RUNE/USD`,
        `${number4.format(row.cumulative_rune || 0)} cumulative RUNE`
      ]
    });
  }

  $: collectedPick = pickAggRows(inflows, granularity.collected);
  $: paidPick = pickPaidRows(reserveEvents, weeklyRows, granularity.paid);
  $: generatedPick = pickAggRows(generatedFees, granularity.generated);

  $: if (collectedCanvas && collectedPick.rows.length) renderCollectedChart(collectedPick, view.collected);
  $: if (paymentCanvas && paidPick.rows.length) renderPaymentChart(paidPick, view.paid);
  $: if (generatedFeesCanvas && generatedPick.rows.length)
    renderGeneratedFeesChart(generatedPick, view.generated);

  onMount(() => {
    loadArtifacts().then(() => {
      refreshReservePayments();
      refreshGeneratedFees();
    });
    refreshLiveState();

    return () => {
      collectedChart?.destroy();
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
      artifactsError = '';
      generatedFeesError = '';
      generatedFeesWarning = '';
      const [csvRows, eventRows, metaJson, generatedFeesResult, inflowsResult] = await Promise.all([
        fetchDataFile('rujira-base-layer-fees.csv', parseCsv),
        fetchDataFile('rujira-base-layer-fees-events.json', JSON.parse),
        fetchDataFile('rujira-base-layer-fees-meta.json', JSON.parse),
        fetchDataFile('rujira-app-layer-swap-fees.json', JSON.parse).catch((error) => ({
          __error: error.message
        })),
        fetchDataFile('rujira-base-layer-inflows.json', JSON.parse).catch((error) => ({
          __error: error.message
        }))
      ]);

      staticWeeklyRows = csvRows;
      staticReserveEvents = eventRows.map((event) => normalizeReserveEvent(event, csvRows));
      staticReserveMeta = metaJson;
      if (generatedFeesResult?.__error) {
        staticGeneratedFees = null;
      } else {
        staticGeneratedFees = generatedFeesResult;
      }
      if (inflowsResult?.__error) {
        inflows = null;
        inflowsError = `Base Layer earnings artifact — ${inflowsResult.__error}; run scripts/rujira-base-layer-inflows.mjs to generate it`;
      } else {
        inflows = inflowsResult;
        inflowsError = '';
      }
    } catch (error) {
      artifactsError = error.message;
    } finally {
      inflowsLoading = false;
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
        reservePaymentsWarning = `reserve-payment DB backfill in progress — ${dbEventCount}/${staticEventCount} events loaded; using ${staticArtifactLabel(staticReserveMeta)}`;
        return;
      }
      weeklyRows = payload.weekly;
      reserveEvents = payload.events.map((event) => normalizeReserveEvent(event, payload.weekly));
      meta = payload.meta || {};
    } catch (error) {
      if (weeklyRows.length) {
        reservePaymentsWarning = `reserve-payment DB — ${error.message}; using last successful payload`;
      } else if (staticWeeklyRows.length) {
        weeklyRows = staticWeeklyRows;
        reserveEvents = staticReserveEvents;
        meta = staticReserveMeta;
        reservePaymentsWarning = `reserve-payment DB — ${error.message}; using ${staticArtifactLabel(staticReserveMeta)}`;
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
        generatedFeesWarning = `generated-fee DB — ${error.message}; using last successful payload`;
      } else if (staticGeneratedFees) {
        generatedFees = staticGeneratedFees;
        generatedFeesWarning = `generated-fee DB — ${error.message}; using ${staticArtifactLabel(staticGeneratedFees?.meta, 'narrow Base Collector conversion fallback')} (not comparable to the broad backend activity series)`;
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
      collectorBalances = liveState.collector_balances || { base: balances };
      collectorActions = liveState.actions || {};
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

  function startOfUtcWeek(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + mondayOffset);
    return d;
  }

  function normalizeBuckets(rows, grain) {
    const startKey = grain === 'weekly' ? 'week_start' : 'day_start';
    return rows.map((row) => ({ ...row, bucket_start: row[startKey] }));
  }

  // Pre-aggregated source (collected inflows / generated fees): use the
  // requested grain, falling back to whichever grain the artifact carries.
  function pickAggRows(source, grain) {
    const daily = source?.daily || [];
    const weekly = source?.weekly || [];
    if (grain === 'daily' && daily.length) return { rows: normalizeBuckets(daily, 'daily'), grain: 'daily' };
    if (grain === 'weekly' && weekly.length) return { rows: normalizeBuckets(weekly, 'weekly'), grain: 'weekly' };
    if (daily.length) return { rows: normalizeBuckets(daily, 'daily'), grain: 'daily' };
    return { rows: normalizeBuckets(weekly, 'weekly'), grain: 'weekly' };
  }

  // Reserve deposits arrive as per-event rows, so bucket them client-side at
  // the requested grain — daily needs no separate backend series.
  function bucketReserveEvents(events, grain) {
    const startOf =
      grain === 'weekly'
        ? (d) => startOfUtcWeek(d)
        : (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const map = new Map();
    for (const event of events) {
      const date = new Date(event.date);
      if (!Number.isFinite(date.getTime())) continue;
      const key = startOf(date).toISOString().slice(0, 10);
      const row =
        map.get(key) ||
        { bucket_start: key, payments: 0, payment_rune: 0, payment_usd: 0, priceNum: 0, priceDen: 0 };
      const amountRune = Number(event.amountRune) || 0;
      row.payments += 1;
      row.payment_rune += amountRune;
      row.payment_usd += Number(event.amountUsd) || 0;
      row.priceNum += (Number(event.runePriceUsd) || 0) * amountRune;
      row.priceDen += amountRune;
      map.set(key, row);
    }
    let cumUsd = 0;
    let cumRune = 0;
    return [...map.values()]
      .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start))
      .map((row) => {
        cumUsd += row.payment_usd;
        cumRune += row.payment_rune;
        return {
          bucket_start: row.bucket_start,
          payments: row.payments,
          payment_rune: row.payment_rune,
          payment_usd: row.payment_usd,
          rune_price_usd: row.priceDen > 0 ? row.priceNum / row.priceDen : 0,
          cumulative_usd: cumUsd,
          cumulative_rune: cumRune
        };
      });
  }

  function pickPaidRows(events, weeklyFallback, grain) {
    if (events && events.length) {
      return { rows: bucketReserveEvents(events, grain), grain };
    }
    return { rows: normalizeBuckets(weeklyFallback || [], 'weekly'), grain: 'weekly' };
  }

  // Fill absent buckets with zero-value rows (cumulative carried forward) so
  // scheduler pauses read as real gaps instead of a compressed axis.
  function fillBucketGaps(rows, valueField, cumulativeField, stepDays) {
    if (rows.length < 2) return rows;
    const stepMs = stepDays * 86400 * 1000;
    const out = [];
    let prev = null;
    let guard = 0;
    for (const row of rows) {
      if (prev) {
        let cursor = new Date(`${prev.bucket_start}T00:00:00Z`);
        for (;;) {
          cursor = new Date(cursor.getTime() + stepMs);
          const key = cursor.toISOString().slice(0, 10);
          if (key >= row.bucket_start || (guard += 1) > 1000) break;
          out.push({
            bucket_start: key,
            [valueField]: 0,
            [cumulativeField]: prev[cumulativeField] || 0
          });
        }
      }
      out.push(row);
      prev = row;
    }
    return out;
  }

  // Single-axis bar / cumulative-line chart, switched by view.
  function renderSeriesChart(canvas, previousChart, config) {
    previousChart?.destroy();
    const { grain, view: chartView, colors, valueField, cumulativeField, barLabel, cumulativeLabel, afterBody, zoomKey } = config;
    const stepDays = grain === 'weekly' ? 7 : 1;
    const rows = fillBucketGaps(config.rows, valueField, cumulativeField, stepDays);
    const cumulative = chartView === 'cumulative';
    const dataset = cumulative
      ? {
          type: 'line',
          label: cumulativeLabel,
          data: rows.map((row) => row[cumulativeField] || 0),
          borderColor: colors.mark,
          backgroundColor: colors.faint,
          pointBackgroundColor: colors.mark,
          pointBorderColor: '#080808',
          pointRadius: rows.length > 45 ? 0 : 3,
          borderWidth: 2,
          tension: 0.2,
          fill: true
        }
      : {
          type: 'bar',
          label: barLabel,
          data: rows.map((row) => row[valueField] || 0),
          backgroundColor: colors.fill,
          borderColor: colors.mark,
          borderWidth: rows.length > 90 ? 0 : 1,
          borderRadius: 0
        };

    return new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: rows.map((row) => formatWeekLabel(row.bucket_start)),
        datasets: [dataset]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0a0a0a',
            borderColor: '#1a1a1a',
            borderWidth: 1,
            titleColor: colors.chrome,
            bodyColor: '#c8c8c8',
            titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
            callbacks: {
              afterBody(items) {
                return afterBody ? afterBody(rows[items[0].dataIndex]) : [];
              },
              label(context) {
                return `${context.dataset.label}: ${usd2.format(context.raw)}`;
              }
            }
          },
          zoom: {
            limits: { x: { minRange: 1 } },
            zoom: {
              // Drag-to-select the time range; wheel is intentionally off so
              // scrolling past the chart doesn't get trapped zooming it.
              mode: 'x',
              wheel: { enabled: false },
              pinch: { enabled: true },
              drag: {
                enabled: true,
                backgroundColor: colors.faint,
                borderColor: colors.mark,
                borderWidth: 1
              },
              onZoomComplete: zoomKey ? () => markZoomed(zoomKey, true) : undefined
            }
          }
        },
        scales: {
          x: {
            grid: { color: '#111', drawBorder: false },
            border: { color: '#1a1a1a' },
            ticks: { color: '#666', font: { family: "'JetBrains Mono', monospace", size: 10 } }
          },
          y: {
            grid: { color: '#111', drawBorder: false },
            border: { color: '#1a1a1a' },
            ticks: {
              color: colors.chrome,
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              callback: (value) => (value >= 1000 ? usd0.format(value) : usd2.format(value))
            }
          }
        }
      }
    });
  }

  function getTargetsForConfig(collectorKey, config) {
    const targetRows = config?.target_addresses;
    if (!Array.isArray(targetRows) || !targetRows.length) {
      return (staticTargets[collectorKey] || []).map((target) => ({ ...target, isFallback: true }));
    }

    const totalWeight = targetRows.reduce((sum, [, weight]) => sum + Number(weight || 0), 0);
    return targetRows.map(([address, weight]) => ({
      address,
      label: addressLabels[address] || formatAddress(address),
      percent: totalWeight > 0 ? (Number(weight) / totalWeight) * 100 : 0,
      isFallback: false
    }));
  }

  function amountFromBase(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric / 1e8 : 0;
  }

  function normalizeReserveEvent(event, priceRows = []) {
    const amountRune = Number(event.amountRune ?? event.amount_rune ?? amountFromBase(event.amountBase));
    const runePriceUsdValue = Number(
      event.runePriceUsd ??
      event.rune_price_usd ??
      reservePriceForDate(event.date, priceRows)
    );
    const amountUsd = Number(event.amountUsd ?? event.amount_usd ?? amountRune * runePriceUsdValue);
    return {
      ...event,
      amountRune,
      runePriceUsd: runePriceUsdValue,
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

  function denomLabel(denom) {
    if (!denom) return '';
    if (denom === 'rune') return 'RUNE';
    if (denom.startsWith('x/')) return denom.slice(2).toUpperCase();
    const pool = denomToPoolAsset(denom);
    const dashAt = pool.indexOf('-');
    return dashAt === -1 ? pool : pool.slice(0, dashAt);
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

  function normalizeDenom(denom) {
    return String(denom || '').trim().toLowerCase();
  }

  function summarizeInventoryBucket(rows) {
    const pricedUsd = rows.reduce((sum, row) => sum + (Number(row.usdValue) || 0), 0);
    return {
      rows,
      count: rows.length,
      pricedUsd,
      unpricedCount: rows.filter((row) => row.amount > 0 && !row.usdValue).length
    };
  }

  function summarizeCollectorInventory(config, balanceRows, actionRows) {
    if (!Array.isArray(config?.target_denoms) || !Array.isArray(balanceRows)) {
      return EMPTY_INVENTORY;
    }

    const targetDenoms = new Set(config.target_denoms.map(([denom]) => normalizeDenom(denom)));
    const actionsAvailable = Array.isArray(actionRows);
    const actionDenoms = new Set((actionRows || []).map((action) => normalizeDenom(action?.denom)));
    const buckets = { eligible: [], conversion: [], blocked: [], unresolved: [] };

    for (const balance of balanceRows || []) {
      const amount = amountFromBase(balance.amount);
      if (!(amount > 0)) continue;
      const row = { ...balance, amount, usdValue: estimateUsd(balance) };
      const denom = normalizeDenom(balance.denom);
      if (targetDenoms.has(denom)) {
        buckets.eligible.push(row);
      } else if (!actionsAvailable) {
        buckets.unresolved.push(row);
      } else if (actionDenoms.has(denom)) {
        buckets.conversion.push(row);
      } else {
        buckets.blocked.push(row);
      }
    }

    const eligible = summarizeInventoryBucket(buckets.eligible);
    const conversion = summarizeInventoryBucket(buckets.conversion);
    const blocked = summarizeInventoryBucket(buckets.blocked);
    const unresolved = summarizeInventoryBucket(buckets.unresolved);
    return {
      available: true,
      actionsAvailable,
      eligible,
      conversion,
      blocked,
      unresolved,
      pricedUsd: eligible.pricedUsd + conversion.pricedUsd + blocked.pricedUsd + unresolved.pricedUsd
    };
  }

  function inventoryDisplay(bucket) {
    if (!bucket?.count) return '—';
    if (bucket.pricedUsd > 0) return usd2.format(bucket.pricedUsd);
    return `${number2.format(bucket.count)} denom${bucket.count === 1 ? '' : 's'}`;
  }

  function targetRatePerSecond(config, denom) {
    const target = (config?.target_denoms || [])
      .find(([targetDenom]) => normalizeDenom(targetDenom) === normalizeDenom(denom));
    return target ? amountFromBase(target[1]) : 0;
  }

  function formatDataSource(source) {
    const value = String(source || '').trim();
    if (!value) return 'fallback artifact';
    if (value.includes('mixed')) return 'Dune + RPC/Midgard Postgres';
    if (value.includes('dune')) return 'Dune-backed Postgres';
    if (value.includes('postgres')) return 'RPC/Midgard-backed Postgres';
    if (value.includes('static')) return 'static artifact';
    return value.replaceAll('-', ' ');
  }

  function staticArtifactLabel(artifactMeta, label = 'static fallback artifact') {
    const generatedAt = artifactMeta?.generatedAt;
    return generatedAt ? `${label} generated ${formatDateTime(generatedAt)}` : label;
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

  function targetSummary(targets) {
    return (targets || [])
      .map((target) => `${target.percent.toFixed(0)}% → ${target.label}`)
      .join('  ·  ');
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
      App-layer fees, tracked in three steps: <b class="k-collected">01 accrued</b> for the Base
      Layer, <b class="k-paid">02 paid</b> out to the TC Reserve, and
      <b class="k-generated">03 liquidity fees generated</b> on THORChain pools along the way.
      <b class="k-benefit">Σ total benefit to THORChain</b> = 02 (realized to the Reserve) + 03
      (realized to System Income). Cumulative 01 approximates 02 plus base-layer-bound inventory, so it is
      not added to the total.
    </p>
    <div class="rule"></div>
  </div>

  {#if artifactsError || reservePaymentsError || reservePaymentsWarning || generatedFeesError || generatedFeesWarning || inflowsError || liveError || liveRouteWarning}
    <div class="alerts">
      {#if artifactsError}
        <div class="alert err">
          <span class="alert-tag">ERR</span>
          <span>artifact data — {artifactsError}</span>
        </div>
      {/if}
      {#if inflowsError}
        <div class="alert warn">
          <span class="alert-tag">WRN</span>
          <span>{inflowsError}</span>
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

  <!-- ============ FLOW OF FUNDS ============ -->
  <section class="block flowmap-block">
    <div class="block-head">
      <div class="block-title">
        <span class="title-marker">▌</span>
        <h2>flow of funds</h2>
      </div>
      <div class="block-meta">
        {#if lastLiveRefresh}
          [live config {formatDateTime(lastLiveRefresh)}]
        {:else}
          [pending live refresh]
        {/if}
      </div>
    </div>

    <div class="fmap">
      <div class="fnode dim" style="grid-area: apps;">
        <span class="fnode-kicker">source</span>
        <strong class="fnode-name">Rujira Apps</strong>
        <p class="fnode-sub">
          RUJI Trade · RUJI Swap · RUJI Index · core apps — trading fees accrue continuously
        </p>
      </div>

      <div class="fpipe neutral" style="grid-area: p1;">
        <span class="fpipe-tag">fees</span>
        <span class="fpipe-line"></span>
        <span class="fpipe-arrow">▶</span>
      </div>

      <div class="fnode dim" style="grid-area: cols;">
        <span class="fnode-kicker">app collectors</span>
        <strong class="fnode-name">Revenue Collectors</strong>
        <strong class="fnode-fig neutral">{liveLoading ? '—' : usd2.format(appCollectorInventoryUsd)}</strong>
        <p class="fnode-sub">currently held across trade / core / swap / index collectors</p>
      </div>

      <div class="fpipe amber" style="grid-area: p2;">
        <span class="fpipe-tag">{liveLoading || !baseShares.trade ? '≈50%' : `${baseShares.trade.toFixed(0)}%`} of trade + core</span>
        <span class="fpipe-line"></span>
        <span class="fpipe-arrow">▶</span>
      </div>

      <a class="fnode amber stage" style="grid-area: base;" href="#chart-collected">
        <span class="fnode-kicker"><i>01</i> accrued</span>
        <strong class="fnode-name">Base Layer Revenue Share</strong>
        <strong class="fnode-fig">{inflowsLoading ? '—' : totalInflowUsd ? usd2.format(totalInflowUsd) : 'scan pending'}</strong>
        <p class="fnode-sub">
          {liveLoading ? '—' : usd2.format(pendingKnownUsd)} remains base-layer-bound upstream or pending here
        </p>
      </a>

      <div class="fpipe green" style="grid-area: p3;">
        <span class="fpipe-tag">RUNE drip{baseRuneRatePerSecond > 0 ? ` · ${number4.format(baseRuneRatePerSecond)}/s cap` : ''}</span>
        <span class="fpipe-line"></span>
        <span class="fpipe-arrow">▶</span>
      </div>

      <a class="fnode green stage" style="grid-area: reserve;" href="#chart-paid">
        <span class="fnode-kicker"><i>02</i> paid</span>
        <strong class="fnode-name">TC Reserve</strong>
        <strong class="fnode-fig">{reservePaymentsLoading && !weeklyRows.length ? '—' : usd2.format(latestWeek?.cumulative_usd || 0)}</strong>
        <p class="fnode-sub">
          MsgDeposit RESERVE · {number2.format(meta?.eventCount || 0)} deposits into the THORChain Reserve
        </p>
      </a>

      <div class="fpipe-v neutral" style="grid-area: pv;">
        <span class="fpipe-tag">{liveLoading || !baseShares.trade ? '≈50%' : `${(100 - baseShares.trade).toFixed(0)}%`}</span>
        <span class="fpipe-line-v"></span>
        <span class="fpipe-arrow">▼</span>
      </div>

      <div class="fnode dim faded" style="grid-area: stak;">
        <span class="fnode-kicker">out of scope</span>
        <strong class="fnode-name">RUJI Stakers</strong>
        <p class="fnode-sub">the other half of trade + core revenue — never reaches the base layer</p>
      </div>

      <div class="fchannel" style="grid-area: chan;">
        <div class="fchannel-rail">
          <span class="fchannel-note">every conversion swap and app trade also routes through TC pools…</span>
          <span class="fpipe-line blue-line"></span>
          <span class="fpipe-arrow blue-arrow">▶</span>
        </div>
        <a class="fnode blue stage fchannel-node" href="#chart-generated">
          <span class="fnode-kicker"><i>03</i> generated</span>
          <strong class="fnode-name">TC Liquidity Fees</strong>
          <strong class="fnode-fig">{generatedFeesLoading && !generatedFeeRows.length ? '—' : usd2.format(totalGeneratedFeeUsd)}</strong>
          <p class="fnode-sub">flows to THORChain System Income, not the Reserve; counted in Σ benefit alongside 02, never with 01</p>
        </a>
      </div>
    </div>

    <div class="flow-legend">
      <span><b class="k-collected">01</b> Base Layer share accrues in app collectors</span>
      <span class="legend-arrow">→</span>
      <span>held &amp; converted to RUNE</span>
      <span class="legend-arrow">→</span>
      <span><b class="k-paid">02</b> dripped into the Reserve</span>
      <span class="legend-sep">│</span>
      <span><b class="k-generated">03</b> pool fees generated along the way flow to System Income</span>
      <span class="legend-sep">│</span>
      <span><b class="k-benefit">Σ</b> benefit to TC = 02 + 03</span>
    </div>
  </section>

  <!-- ============ TOTAL BENEFIT ============ -->
  <article class="benefit-hero">
    <div class="benefit-hero-main">
      <div class="metric-head">
        <span class="benefit-hero-sigma">Σ</span>
        <span class="metric-label">total benefit to thorchain</span>
      </div>
      <strong class="benefit-hero-value">{totalBenefitLoading ? '—' : usd2.format(totalBenefitUsd)}</strong>
      <small class="metric-foot">
        <b class="k-paid">02</b> paid to Reserve + <b class="k-generated">03</b> liquidity fees to System Income · excludes 01 accrual &amp; pending
      </small>
    </div>
    <div class="benefit-hero-split">
      <div class="benefit-hero-leg green">
        <span>02 → tc reserve</span>
        <strong>{reservePaymentsLoading && !weeklyRows.length ? '—' : usd2.format(totalReservePaidUsd)}</strong>
        <small>{totalBenefitUsd > 0 ? `${benefitReserveShare.toFixed(0)}% · realized` : 'realized'}</small>
      </div>
      <div class="benefit-hero-leg blue">
        <span>03 → system income</span>
        <strong>{generatedFeesLoading && !generatedFeeRows.length ? '—' : usd2.format(totalGeneratedFeeUsd)}</strong>
        <small>{totalBenefitUsd > 0 ? `${benefitLpShare.toFixed(0)}% · liq fees` : 'liq fees'}</small>
      </div>
    </div>
  </article>

  <!-- ============ METRICS ============ -->
  <div class="metric-grid">
    <article class="metric">
      <div class="metric-head">
        <span class="metric-idx amber-i">01</span>
        <span class="metric-label">app-layer earnings for base layer</span>
      </div>
      <strong class="metric-value">{inflowsLoading ? '—' : totalInflowUsd ? usd2.format(totalInflowUsd) : '—'}</strong>
      <small class="metric-foot">
        {inflowMeta ? `${usd2.format(inflowOpeningUsd)} opening + ${usd2.format(inflowNetNewUsd)} net new · daily prices` : 'inflow artifact pending'}
      </small>
    </article>
    <article class="metric">
      <div class="metric-head">
        <span class="metric-idx">02</span>
        <span class="metric-label">paid to tc reserve</span>
      </div>
      <strong class="metric-value">{reservePaymentsLoading && !weeklyRows.length ? '—' : usd2.format(latestWeek?.cumulative_usd || 0)}</strong>
      <small class="metric-foot">{number2.format(latestWeek?.cumulative_rune || 0)} RUNE · USD at dispersal</small>
    </article>
    <article class="metric">
      <div class="metric-head">
        <span class="metric-idx blue-i">03</span>
        <span class="metric-label">tc liq fees generated</span>
      </div>
      <strong class="metric-value">
        {generatedFeesLoading && !generatedFeeRows.length ? '—' : usd2.format(totalGeneratedFeeUsd)}
      </strong>
      <small class="metric-foot">{number4.format(totalGeneratedFeeRune)} RUNE · System Income side of Σ benefit</small>
    </article>
    <article class="metric">
      <div class="metric-head">
        <span class="metric-idx dim-i">--</span>
        <span class="metric-label">pending base-layer-bound</span>
      </div>
      <strong class="metric-value">{liveLoading ? '—' : usd2.format(pendingKnownUsd)}</strong>
      <small class="metric-foot">{usd2.format(upstreamBaseBoundUsd)} upstream · {usd2.format(baseRoutableInventoryUsd)} in Base collector</small>
    </article>
  </div>

  <!-- ============ 01 COLLECTED ============ -->
  <section class="block" id="chart-collected">
    <div class="block-head">
      <div class="block-title">
        <span class="title-marker amber">▌</span>
        <h2>01 · app-layer earnings allocated to the base layer</h2>
      </div>
      <div class="chart-controls amber-t">
        <div class="mode-toggle">
          <button class:active={granularity.collected === 'daily'} on:click={() => setGranularity('collected', 'daily')}>[daily]</button>
          <button class:active={granularity.collected === 'weekly'} on:click={() => setGranularity('collected', 'weekly')}>[weekly]</button>
        </div>
        <span class="ctrl-div">·</span>
        <div class="mode-toggle">
          <button class:active={view.collected === 'bars'} on:click={() => setView('collected', 'bars')}>[bars]</button>
          <button class:active={view.collected === 'cumulative'} on:click={() => setView('collected', 'cumulative')}>[cumul]</button>
        </div>
        <span class="ctrl-div">·</span>
        <span class="zoom-hint">drag to zoom</span>
        <button class="zoom-reset" on:click={() => resetZoom('collected')} disabled={!zoomed.collected}>[reset]</button>
      </div>
    </div>
    <p class="block-lede">
      Each daily or weekly bar is newly earned app-layer value allocated to the Base Layer: 100%
      of routable Base Collector inventory changes plus the configured Base Layer share of
      routable RUJI Trade and Other Core Apps inventory changes. Internal route transfers,
      conversions, and final Reserve payouts cancel rather than create new earnings. The optional
      cumulative view rolls up those period earnings and overlaps 02; it is not additive.
      Source: {formatDataSource(inflowMeta?.source)}.
    </p>

    <div class="side-layout">
      <div class="chart-frame">
        {#if inflowsLoading}
          <div class="loading-block">
            <span class="loading-marker">▓░░░░</span>
            <span>loading Base Layer earnings artifact</span>
          </div>
        {:else if !inflowRows.length}
          <div class="loading-block">
            <span class="loading-marker">░░░░░</span>
            <span>no Base Layer earnings rows — run scripts/rujira-base-layer-inflows.mjs</span>
          </div>
        {:else}
          <canvas bind:this={collectedCanvas} aria-label="Daily, weekly, and cumulative app-layer earnings allocated to the Base Layer"></canvas>
        {/if}
      </div>

      <div class="side-panel amber-p">
        <div class="side-card">
          <span>cumulative app-layer earnings</span>
          <strong>{totalInflowUsd ? usd2.format(totalInflowUsd) : '—'}</strong>
          <small>{inflowMeta ? `${number2.format(inflowDayCount)} days measured · paid + pending reconciliation` : 'artifact pending'}</small>
        </div>
        {#if inflowDenomTotals.length}
          <p class="side-table-note">largest net asset flows · + received / − converted or paid</p>
          <div class="table-scroll side-table">
            <table>
              <thead>
                <tr>
                  <th>denom</th>
                  <th>amount</th>
                  <th>usd</th>
                </tr>
              </thead>
              <tbody>
                {#each inflowDenomTotals as row}
                  <tr>
                    <td class="mono ellipsis" title={row.denom}>{denomLabel(row.denom)}</td>
                    <td class="num">{signedNumber4.format(row.amount)}</td>
                    <td class="num accent-amber">{row.priced ? signedUsd2.format(row.usd) : 'unpriced'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        <p class="scope-note">
          {inflowMeta?.scope || 'Scan scope pending.'}
          {inflowMeta?.unpricedCoinCount ? ` ${number2.format(inflowMeta.unpricedCoinCount)} coins had no price history and are excluded from USD sums.` : ''}
        </p>
      </div>
    </div>
  </section>

  <!-- ============ 02 PAID ============ -->
  <section class="block" id="chart-paid">
    <div class="block-head">
      <div class="block-title">
        <span class="title-marker">▌</span>
        <h2>02 · fees paid to tc reserve</h2>
      </div>
      <div class="chart-controls green-t">
        <div class="mode-toggle">
          <button class:active={granularity.paid === 'daily'} on:click={() => setGranularity('paid', 'daily')}>[daily]</button>
          <button class:active={granularity.paid === 'weekly'} on:click={() => setGranularity('paid', 'weekly')}>[weekly]</button>
        </div>
        <span class="ctrl-div">·</span>
        <div class="mode-toggle">
          <button class:active={view.paid === 'bars'} on:click={() => setView('paid', 'bars')}>[bars]</button>
          <button class:active={view.paid === 'cumulative'} on:click={() => setView('paid', 'cumulative')}>[cumul]</button>
        </div>
        <span class="ctrl-div">·</span>
        <span class="zoom-hint">drag to zoom</span>
        <button class="zoom-reset" on:click={() => resetZoom('paid')} disabled={!zoomed.paid}>[reset]</button>
      </div>
    </div>
    <p class="block-lede">
      RESERVE deposits from the Base Layer collector, valued as RUNE deposited × the historical
      RUNE/USD rate at the time of each deposit rather than its current value. Range:
      {#if firstEvent && latestEvent}
        {formatWeekLabel(firstEvent.date.slice(0, 10))} → {formatWeekLabel(latestEvent.date.slice(0, 10))}.
      {:else}
        loading.
      {/if}
      Source in use: {reservePaymentSource} · {reservePaymentBackfillLabel}.
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
      <details class="fold">
        <summary><span class="fold-marker">+</span> weekly breakdown table</summary>
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
      </details>
    {/if}
  </section>

  <!-- ============ 03 GENERATED ============ -->
  <section class="block" id="chart-generated">
    <div class="block-head">
      <div class="block-title">
        <span class="title-marker blue">▌</span>
        <h2>03 · tc liquidity fees generated by app activity</h2>
      </div>
      <div class="chart-controls blue-t">
        <div class="mode-toggle">
          <button class:active={granularity.generated === 'daily'} on:click={() => setGranularity('generated', 'daily')}>[daily]</button>
          <button class:active={granularity.generated === 'weekly'} on:click={() => setGranularity('generated', 'weekly')}>[weekly]</button>
        </div>
        <span class="ctrl-div">·</span>
        <div class="mode-toggle">
          <button class:active={view.generated === 'bars'} on:click={() => setView('generated', 'bars')}>[bars]</button>
          <button class:active={view.generated === 'cumulative'} on:click={() => setView('generated', 'cumulative')}>[cumul]</button>
        </div>
        <span class="ctrl-div">·</span>
        <span class="zoom-hint">drag to zoom</span>
        <button class="zoom-reset" on:click={() => resetZoom('generated')} disabled={!zoomed.generated}>[reset]</button>
      </div>
    </div>
    <p class="block-lede">
      THORChain liquidity fees attributed to Rujira contract activity. These fees flow into
      THORChain System Income rather than the Reserve, and are counted toward Total Benefit to TC
      alongside 02. Source: {generatedFeeSource} · {generatedFeeBackfillLabel}. Scan scope:
      {generatedFeeScope}
    </p>

    <div class="side-layout">
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

      <div class="side-panel blue-p">
        <div class="side-card">
          <span>generated fees</span>
          <strong>{usd2.format(totalGeneratedFeeUsd)}</strong>
          <small>{number4.format(totalGeneratedFeeRune)} RUNE · {number2.format(generatedFeeMeta?.matchedSwapFeeEventCount || 0)} swap events</small>
        </div>
        {#if topGeneratedFeeRoutes.length}
          <div class="table-scroll side-table">
            <table>
              <thead>
                <tr>
                  <th>route</th>
                  <th>events</th>
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
                    <td class="num accent-blue">{usd2.format(route.liquidity_fee_usd || 0)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        <p class="scope-note">{generatedFeeMeta?.caveat || 'Generated-fee scan is being prepared.'}</p>
      </div>
    </div>
  </section>

  <!-- ============ LIVE CONTEXT ============ -->
  <section class="block">
    <div class="block-head">
      <div class="block-title">
        <span class="title-marker">▌</span>
        <h2>live collector routing</h2>
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
      Live <span class="inline-code">rujira-revenue</span> configuration. Percentages are address
      allocations for eligible target denoms; conversion queues are balances that still need a
      configured action before they can move.
    </p>
    <div class="table-scroll">
      <table class="routing-table">
        <thead>
          <tr>
            <th>collector</th>
            <th>code</th>
            <th>eligible</th>
            <th>conversion queue</th>
            <th>targets</th>
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
              <td class="num">{latestCodeIds[collector.key]}</td>
              <td class="num">{collectorInventories[collector.key]?.available ? inventoryDisplay(collectorInventories[collector.key].eligible) : '—'}</td>
              <td class="num">{collectorInventories[collector.key]?.available ? inventoryDisplay(collectorInventories[collector.key].conversion) : '—'}</td>
              <td class="mono targets-cell">{targetSummary(targetMap[collector.key])}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <div class="split">
    <article class="block">
      <div class="block-head">
        <div class="block-title">
          <span class="title-marker">▌</span>
          <h2>base collector inventory</h2>
        </div>
        <div class="block-meta">[{topBalances.length} denoms]</div>
      </div>
      <p class="block-lede">Current Base collector balances. USD is estimated from available RUNE, pool, and stable prices; a balance is not automatically Reserve-bound.</p>
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
              <th>tx</th>
              <th>rune</th>
              <th>usd sent</th>
            </tr>
          </thead>
          <tbody>
            {#each recentEvents as event}
              <tr>
                <td class="mono">{formatDateTime(event.date)}</td>
                <td class="num">
                  <a class="table-link" href={txUrl(event.id)} target="_blank" rel="noopener noreferrer" title={event.id}>
                    {formatTxId(event.id)}
                  </a>
                </td>
                <td class="num accent">{number4.format(event.amountRune)}</td>
                <td class="num accent">{event.amountUsd ? usd2.format(event.amountUsd) : '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </article>
  </div>

  <!-- ============ ARCHIVE ============ -->
  <section class="block archive-block">
    <details class="fold">
      <summary>
        <span class="fold-marker">+</span> archive — version path, contract history &amp; similar contracts
      </summary>

      <div class="archive-body">
        <div class="archive-section">
          <h3 class="archive-title">version path</h3>
          <ol class="timeline">
            {#each versionTimeline as item, index}
              <li>
                <div class="t-idx">{String(index + 1).padStart(2, '0')}</div>
                <div class="t-rail">
                  <span class="t-node"></span>
                  {#if index < versionTimeline.length - 1}<span class="t-line"></span>{/if}
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
        </div>

        <div class="split">
          <div class="archive-section">
            <h3 class="archive-title">contract history</h3>
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
          </div>

          <div class="archive-section">
            <h3 class="archive-title">similar contracts</h3>
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
          </div>
        </div>
      </div>
    </details>
  </section>

  <footer class="foot">
    <div class="foot-line">
      <span class="foot-tag">artifacts</span>
      <span>{meta?.generatedAt ? formatDateTime(meta.generatedAt) : 'loading'}</span>
    </div>
    <div class="foot-line">
      <span class="foot-tag">path</span>
      <span class="mono">
        apps → collectors →
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
    scroll-behavior: smooth;
  }

  .terminal h1,
  .terminal h2,
  .terminal h3,
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
    max-width: 880px;
  }

  .lede b {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .k-collected {
    color: #d4a017;
  }

  .k-paid {
    color: #00cc66;
  }

  .k-generated {
    color: #44a0ff;
  }

  .k-benefit {
    color: #1fd9a6;
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

  /* ========== FLOW MAP ========== */

  .flowmap-block {
    padding-bottom: 18px;
  }

  .fmap {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 44px minmax(0, 1.05fr) 72px minmax(0, 1.25fr) 72px minmax(0, 1.15fr);
    grid-template-areas:
      'apps p1 cols p2 base p3 reserve'
      '.    .  pv   .  .    .  .'
      '.    .  stak .  .    .  .'
      'chan chan chan chan chan chan chan';
    align-items: stretch;
    row-gap: 0;
  }

  .fnode {
    border: 1px solid #1a1a1a;
    background: #0d0d0d;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
    text-decoration: none;
    color: inherit;
  }

  .fnode.faded {
    opacity: 0.62;
    border-style: dashed;
  }

  .fnode.amber {
    border-color: rgba(212, 160, 23, 0.5);
    background: linear-gradient(180deg, rgba(212, 160, 23, 0.07) 0%, #0a0a0a 65%);
  }

  .fnode.green {
    border-color: rgba(0, 204, 102, 0.5);
    background: linear-gradient(180deg, rgba(0, 204, 102, 0.07) 0%, #0a0a0a 65%);
  }

  .fnode.blue {
    border-color: rgba(68, 160, 255, 0.5);
    background: linear-gradient(180deg, rgba(68, 160, 255, 0.07) 0%, #0a0a0a 65%);
  }

  .fnode.stage {
    cursor: pointer;
    transition: box-shadow 0.15s, transform 0.15s;
  }

  .fnode.stage:hover {
    transform: translateY(-1px);
  }

  .fnode.amber.stage:hover {
    box-shadow: 0 0 16px rgba(212, 160, 23, 0.18);
  }

  .fnode.green.stage:hover {
    box-shadow: 0 0 16px rgba(0, 204, 102, 0.18);
  }

  .fnode.blue.stage:hover {
    box-shadow: 0 0 16px rgba(68, 160, 255, 0.18);
  }

  .fnode-kicker {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 700;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.16em;
  }

  .fnode-kicker i {
    font-style: normal;
    padding: 0 4px;
    margin-right: 5px;
    border: 1px solid #2a2a2a;
    color: #888;
  }

  .fnode.amber .fnode-kicker,
  .fnode.amber .fnode-kicker i {
    color: #d4a017;
    border-color: rgba(212, 160, 23, 0.5);
  }

  .fnode.green .fnode-kicker,
  .fnode.green .fnode-kicker i {
    color: #00cc66;
    border-color: rgba(0, 204, 102, 0.5);
  }

  .fnode.blue .fnode-kicker,
  .fnode.blue .fnode-kicker i {
    color: #44a0ff;
    border-color: rgba(68, 160, 255, 0.5);
  }

  .fnode-name {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 700;
    color: #e0e0e0;
  }

  .fnode-fig {
    font-family: 'JetBrains Mono', monospace;
    font-size: 19px;
    font-weight: 800;
    line-height: 1.1;
    overflow-wrap: anywhere;
  }

  .fnode.amber .fnode-fig {
    color: #d4a017;
  }

  .fnode.green .fnode-fig {
    color: #00cc66;
  }

  .fnode.blue .fnode-fig {
    color: #44a0ff;
  }

  .fnode-fig.neutral {
    color: #b8b8b8;
    font-size: 15px;
  }

  .fnode-sub {
    font-size: 11px;
    color: #666;
    line-height: 1.45;
  }

  .fpipe {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 3px;
    padding: 0 5px;
    min-width: 0;
  }

  .fpipe-tag {
    font-family: 'JetBrains Mono', monospace;
    font-size: 8px;
    font-weight: 700;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    text-align: center;
    line-height: 1.3;
  }

  .fpipe.amber .fpipe-tag {
    color: #d4a017;
  }

  .fpipe.green .fpipe-tag {
    color: #00cc66;
  }

  .fpipe-line {
    width: 100%;
    height: 2px;
    background: repeating-linear-gradient(90deg, currentColor 0 7px, transparent 7px 14px);
    animation: dashflow 0.9s linear infinite;
    opacity: 0.65;
  }

  .fpipe,
  .fpipe-v {
    color: #3a3a3a;
  }

  .fpipe.amber {
    color: rgba(212, 160, 23, 0.75);
  }

  .fpipe.green {
    color: rgba(0, 204, 102, 0.75);
  }

  .fpipe-arrow {
    align-self: flex-end;
    margin-top: -11px;
    font-size: 9px;
    line-height: 1;
    color: currentColor;
  }

  @keyframes dashflow {
    to { background-position: 14px 0; }
  }

  .fpipe-v {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 2px 0;
  }

  .fpipe-v .fpipe-tag {
    color: #555;
  }

  .fpipe-line-v {
    width: 2px;
    flex: 1;
    min-height: 22px;
    background: repeating-linear-gradient(180deg, currentColor 0 7px, transparent 7px 14px);
    animation: dashflow-v 0.9s linear infinite;
    opacity: 0.65;
  }

  @keyframes dashflow-v {
    to { background-position: 0 14px; }
  }

  .fpipe-v .fpipe-arrow {
    align-self: center;
    margin-top: -2px;
  }

  .fchannel {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px dashed #1a1a1a;
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
    gap: 14px;
    align-items: center;
  }

  .fchannel-rail {
    display: flex;
    align-items: center;
    gap: 10px;
    color: rgba(68, 160, 255, 0.7);
    min-width: 0;
  }

  .fchannel-note {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #557799;
    flex-shrink: 1;
  }

  .fchannel-rail .fpipe-line {
    flex: 1;
    min-width: 40px;
  }

  .fchannel-rail .fpipe-arrow {
    align-self: center;
    margin-top: 0;
  }

  .flow-legend {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    margin-top: 14px;
    padding: 9px 12px;
    background: #080808;
    border: 1px solid #111;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #777;
  }

  .flow-legend b {
    font-weight: 700;
  }

  .legend-arrow {
    color: #3a3a3a;
  }

  .legend-sep {
    color: #222;
  }

  /* ========== TOTAL BENEFIT ========== */

  .benefit-hero {
    display: grid;
    grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
    gap: 1px;
    border: 1px solid rgba(31, 217, 166, 0.35);
    background: #1a1a1a;
    margin-bottom: 18px;
  }

  .benefit-hero-main {
    background: linear-gradient(135deg, rgba(31, 217, 166, 0.09) 0%, #0a0a0a 58%);
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 118px;
  }

  .benefit-hero-sigma {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 800;
    color: #1fd9a6;
  }

  .benefit-hero-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 30px;
    font-weight: 800;
    color: #7ff0d0;
    letter-spacing: -0.01em;
    line-height: 1.05;
    margin-top: auto;
    text-shadow: 0 0 22px rgba(31, 217, 166, 0.22);
    overflow-wrap: anywhere;
  }

  .benefit-hero-split {
    display: grid;
    grid-template-rows: 1fr 1fr;
    gap: 1px;
    background: #1a1a1a;
  }

  .benefit-hero-leg {
    background: #0a0a0a;
    padding: 10px 16px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
  }

  .benefit-hero-leg span {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  .benefit-hero-leg strong {
    font-family: 'JetBrains Mono', monospace;
    font-size: 17px;
    font-weight: 800;
    line-height: 1.1;
  }

  .benefit-hero-leg small {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #555;
  }

  .benefit-hero-leg.green {
    border-left: 2px solid #00cc66;
  }

  .benefit-hero-leg.green strong {
    color: #00cc66;
  }

  .benefit-hero-leg.blue {
    border-left: 2px solid #44a0ff;
  }

  .benefit-hero-leg.blue strong {
    color: #44a0ff;
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
    padding: 16px 18px;
    background: #0a0a0a;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 116px;
    transition: background 0.15s;
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

  .metric-idx.amber-i {
    color: #d4a017;
  }

  .metric-idx.blue-i {
    color: #44a0ff;
  }

  .metric-idx.dim-i {
    color: #555;
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
    scroll-margin-top: 16px;
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

  .title-marker.amber {
    color: #d4a017;
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

  /* ========== MODE TOGGLE ========== */

  .chart-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .ctrl-div {
    color: #2a2a2a;
    font-size: 10px;
  }

  .mode-toggle {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .mode-toggle button {
    background: transparent;
    border: none;
    padding: 2px 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #555;
    cursor: pointer;
    letter-spacing: 0.04em;
    transition: color 0.15s;
  }

  .mode-toggle button:hover {
    color: #999;
  }

  .amber-t button.active {
    color: #d4a017;
    font-weight: 700;
  }

  .green-t button.active {
    color: #00cc66;
    font-weight: 700;
  }

  .blue-t button.active {
    color: #44a0ff;
    font-weight: 700;
  }

  .zoom-hint {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: #444;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .zoom-reset {
    background: transparent;
    border: none;
    padding: 2px 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #666;
    cursor: pointer;
    letter-spacing: 0.04em;
    transition: color 0.15s;
  }

  .zoom-reset:hover:not(:disabled) {
    color: #c8c8c8;
  }

  .zoom-reset:disabled {
    color: #2a2a2a;
    cursor: default;
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

  /* ========== SIDE LAYOUT ========== */

  .side-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(300px, 0.8fr);
    gap: 14px;
    align-items: stretch;
  }

  .side-layout .chart-frame {
    height: 380px;
  }

  .side-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-content: start;
    min-width: 0;
  }

  .side-card {
    background: #080808;
    border: 1px solid #141414;
    padding: 12px 14px;
  }

  .amber-p .side-card {
    border-left: 2px solid #d4a017;
  }

  .blue-p .side-card {
    border-left: 2px solid #44a0ff;
  }

  .side-card span {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    margin-bottom: 8px;
  }

  .side-card strong {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 18px;
    color: #e8e8e8;
    font-weight: 800;
    line-height: 1.1;
    overflow-wrap: anywhere;
  }

  .side-card small {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #777;
    margin-top: 7px;
  }

  .side-table {
    overflow-x: hidden;
  }

  .side-table-note {
    margin: 0;
    color: #555;
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    line-height: 1.35;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .side-table table {
    min-width: 0;
    table-layout: fixed;
  }

  .side-table th,
  .side-table td {
    padding-left: 6px;
    padding-right: 6px;
  }

  .side-table th:first-child,
  .side-table td:first-child {
    width: 42%;
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
    text-align: center;
    padding: 0 20px;
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

  /* ========== FOLD ========== */

  .fold {
    margin-top: 12px;
  }

  .fold summary {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #777;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    cursor: pointer;
    padding: 8px 10px;
    border: 1px dashed #1a1a1a;
    background: #080808;
    list-style: none;
    transition: color 0.15s, border-color 0.15s;
    user-select: none;
  }

  .fold summary::-webkit-details-marker {
    display: none;
  }

  .fold summary:hover {
    color: #b8b8b8;
    border-color: #2a2a2a;
  }

  .fold-marker {
    color: #00cc66;
    font-weight: 700;
    margin-right: 6px;
  }

  .fold[open] .fold-marker {
    color: #d4a017;
  }

  .fold[open] summary {
    border-bottom-style: solid;
    margin-bottom: 12px;
  }

  .archive-block {
    padding-bottom: 16px;
  }

  .archive-block .fold {
    margin-top: 0;
  }

  .archive-body {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .archive-section {
    min-width: 0;
  }

  .archive-title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    color: #999;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px dashed #1a1a1a;
  }

  /* ========== SPLIT ========== */

  .split {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    margin-bottom: 14px;
  }

  .archive-body .split {
    margin-bottom: 0;
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

  td.accent-amber {
    color: #d4a017;
  }

  .table-link {
    color: #b8b8b8;
    border-bottom: 1px dotted #2a2a2a;
    text-decoration: none;
    transition: color 0.15s;
  }

  .table-link:hover {
    color: #00cc66;
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

  .routing-table td.targets-cell {
    text-align: left;
    font-size: 10px;
    color: #888;
    max-width: 380px;
  }

  .routing-table th:last-child {
    text-align: left;
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
    text-decoration: none;
    transition: color 0.15s;
  }

  .foot a:hover {
    color: #00cc66;
  }

  /* ========== MOTION ========== */

  @media (prefers-reduced-motion: reduce) {
    .fpipe-line,
    .fpipe-line-v,
    .cursor,
    .dot.ok,
    .loading-marker {
      animation: none;
    }
  }

  /* ========== RESPONSIVE ========== */

  @media (max-width: 1024px) {
    .metric-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .benefit-hero {
      grid-template-columns: 1fr;
    }

    .benefit-hero-split {
      grid-template-rows: none;
      grid-template-columns: 1fr 1fr;
    }

    .fmap {
      grid-template-columns: 1fr;
      grid-template-areas:
        'apps'
        'p1'
        'cols'
        'pv'
        'stak'
        'p2'
        'base'
        'p3'
        'reserve'
        'chan';
    }

    .fpipe {
      flex-direction: row;
      justify-content: flex-start;
      gap: 10px;
      padding: 8px 14px;
    }

    .fpipe .fpipe-line {
      width: 2px;
      height: 26px;
      background: repeating-linear-gradient(180deg, currentColor 0 7px, transparent 7px 14px);
      animation: dashflow-v 0.9s linear infinite;
    }

    .fpipe .fpipe-arrow {
      align-self: center;
      margin-top: 0;
    }

    .fpipe-v {
      flex-direction: row;
      justify-content: flex-start;
      gap: 10px;
      padding: 8px 14px;
    }

    .fpipe-line-v {
      min-height: 26px;
      flex: 0 0 auto;
    }

    .fchannel {
      grid-template-columns: 1fr;
    }

    .split {
      grid-template-columns: 1fr;
    }

    .side-layout {
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

    .benefit-hero-split {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr 1fr;
    }

    .block {
      padding: 14px 14px 18px;
    }

    .block-head {
      flex-wrap: wrap;
    }

    .chart-frame {
      height: 280px;
    }

    .side-layout .chart-frame {
      height: 300px;
    }
  }
</style>
