<script>
  import { onMount, onDestroy } from "svelte";
  import Chart from 'chart.js/auto';
  import { thornode } from '$lib/api';
  import { formatNumber, simplifyNumber, formatCountdown, getAddressSuffix } from '$lib/utils/formatting';
  import { fromBaseUnit } from '$lib/utils/blockchain';
  import { getChurnState, getNodes, getLeaveStatus, LEAVE_STATUS } from '$lib/utils/nodes';
  import { estimateCurrentChurnYields } from '$lib/bond-tracker/apy.js';
  import { calculateAPR, calculateAPY } from '$lib/utils/calculations';
  import { LoadingBar, StatusIndicator, ActionButton, Toast, RefreshIcon, BookmarkIcon, CopyIcon, CurrencySelector } from '$lib/components';
  import { get } from 'svelte/store';
  import {
    currentCurrency,
    exchangeRates,
    currencyConfig,
    initCurrency,
    setCurrency,
    formatCurrency,
    formatCurrencyWithDecimals,
    formatCurrencyCompact,
    getCurrencySymbol,
    fetchHistoricalRates,
    interpolateRate
  } from '$lib/stores/currency';

  const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

  let my_bond_address = "";
  let node_address = ""; // Keep for backwards compatibility
  let showData = false;
  let my_bond = 0;
  let my_bond_ownership_percentage = 0;
  let current_award = 0;
  let my_award = 0;
  let APY = 0;
  let runePriceUSD = 0;
  let nextChurnTime = 0; // This will hold the timestamp of the next churn
  let countdown = ""; // This will hold the formatted countdown string
  let isChurningHalted = false; // HALTCHURNING mimir flag
  let recentChurnTimestamp = 0;
  let nodeOperatorFee = 0;
  let bondvaluebtc = 0;
  let bondAddressSuffix = "";
  let nodeAddressSuffix = "";
  let isMobile = false;
  let nodeStatus = "";
  
  // New variables for multiple bond tracking
  let bondNodes = []; // Array of node data with bonds > 1 RUNE
  let isMultiNode = false; // Whether user has multiple nodes
  let totalBond = 0;
  let totalAward = 0;
  let aggregateAPY = 0;
  let isLoading = false;
  let showContent = true; // Show content by default

  // Churn indicator variables
  let allNodes = []; // All nodes for churn comparison
  let leaveStatus = null; // Single node leave status result
  let forcedToLeave = false; // Single node forced_to_leave flag

  // Historical bond data
  let historyLoaded = false;
  let historyLoading = false;
  let historyProgressCurrent = 0;
  let historyProgressTotal = 0;
  let historyError = null;
  let churnHistory = []; // Array of { height, date, runeStack, usdValue, earned, apy, ratesJson }
  let historyChartCanvas;
  let historyChartInstance;
  let historicalRatesCache = {}; // currency -> fetched points
  let currencyLoading = false;
  let hasHistoricalNodes = false; // Whether the address has bonds to non-current nodes
  let includeHistorical = false; // Toggle for including historical node bonds
  let showNodeListModal = false; // Modal listing bonded nodes

  // Churn table pagination
  const CHURN_PAGE_SIZE = 20;
  let churnPage = 1;
  $: churnReversed = [...churnHistory].reverse();
  $: churnTotalPages = Math.max(1, Math.ceil(churnReversed.length / CHURN_PAGE_SIZE));
  $: { if (churnPage > churnTotalPages) churnPage = 1; }
  $: churnPaged = churnReversed.slice((churnPage - 1) * CHURN_PAGE_SIZE, churnPage * CHURN_PAGE_SIZE);

  // Total rewards = stack growth minus net bond events (most accurate)
  $: netBondChangeRune = churnHistory.reduce((sum, c) => sum + (Math.abs(c.bondChange || 0) >= 1e7 ? c.bondChange : 0), 0);
  $: totalRewardsRune = churnHistory.length >= 2
    ? (churnHistory[churnHistory.length - 1].runeStack - churnHistory[0].runeStack) - netBondChangeRune
    : 0;
  $: totalRewardsUsd = churnHistory.length >= 2
    ? churnHistory.reduce((sum, c) => sum + ((c.reward || 0) / 1e8) * (c.runePrice || 0), 0)
    : 0;

  // Make these reactive (using currency store)
  $: formattedTotalRewards = formatCurrency($exchangeRates, totalRewardsUsd, $currentCurrency);
  $: formattedNetBondChange = formatCurrency($exchangeRates, (netBondChangeRune / 1e8) * runePriceUSD, $currentCurrency);
  $: formattedRunePrice = formatCurrencyWithDecimals($exchangeRates, runePriceUSD, $currentCurrency);
  $: formattedBondValue = formatCurrency($exchangeRates, (my_bond / 1e8) * runePriceUSD, $currentCurrency);
  $: formattedNextAward = formatCurrency($exchangeRates, (my_award / 1e8) * runePriceUSD, $currentCurrency);
  $: formattedAPY = formatCurrency($exchangeRates, ((APY * my_bond) / 1e8) * runePriceUSD, $currentCurrency);
  $: nextAwardBtcValue = (my_award * bondvaluebtc) / my_bond;

  // Using shared formatNumber from $lib/utils/formatting

  // Helper function for human-readable churn reason
  const getChurnReason = (status, forcedToLeave = false) => {
    if (forcedToLeave) return 'Forced';
    if (!status) return '';
    switch (status.type) {
      case LEAVE_STATUS.LEAVING: return 'Requested';
      case LEAVE_STATUS.OLDEST: return 'Oldest';
      case LEAVE_STATUS.WORST: return 'Slash Pts';
      case LEAVE_STATUS.LOWEST: return 'Low Bond';
      default: return status.type;
    }
  };

  const updateAddressesFromURL = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const urlBondAddress = urlParams.get("bond_address");
    const savedAddress = urlBondAddress || localStorage.getItem('bond_tracker_address') || '';

    if (savedAddress) {
      my_bond_address = savedAddress;
      bondAddressSuffix = getAddressSuffix(savedAddress, 4);
      showData = true;
      if (!urlBondAddress) updateURLBondOnly(); // sync URL if loaded from localStorage
      localStorage.setItem('bond_tracker_address', savedAddress);
      fetchBondData();
    }
  };

  const applyChurnInfo = (churnInfo) => {
    if (!churnInfo) return;
    isChurningHalted = churnInfo.isHalted;
    nextChurnTime = churnInfo.nextChurnTimestamp;
    updateCountdown();
  };

  const getChurnEstimateInput = (churnState) => {
    if (!churnState) {
      return {
        lastChurnTimestamp: recentChurnTimestamp,
        churnIntervalSeconds: 0,
        progressedBlocks: 0,
        totalBlocks: 0,
        secondsPerBlock: 0
      };
    }

    const lastChurnHeight = Number(churnState.lastChurnHeight || 0);
    const nextChurnHeight = Number(churnState.nextChurnHeight || 0);
    const totalBlocks = Math.max(
      0,
      nextChurnHeight - lastChurnHeight || Number(churnState.churnIntervalBlocks || 0)
    );
    const currentHeight = Number(churnState.currentHeight || 0);
    const progressedBlocks = totalBlocks > 0
      ? Math.max(0, Math.min(totalBlocks, currentHeight - lastChurnHeight))
      : 0;
    const secondsPerBlock = Number(churnState.secondsPerBlock || 0);

    return {
      lastChurnTimestamp: Number(churnState.lastChurnTimestamp || 0),
      churnIntervalSeconds: totalBlocks > 0 && secondsPerBlock > 0
        ? totalBlocks * secondsPerBlock
        : 0,
      progressedBlocks,
      totalBlocks,
      secondsPerBlock
    };
  };

  const updateCountdown = () => {
    const now = Date.now() / 1000;
    const secondsLeft = nextChurnTime - now;
    countdown = formatCountdown(secondsLeft, { zeroText: 'Now!' });
  };

  function getBondProviderForAddress(node, bondAddress) {
    const target = String(bondAddress || '').toLowerCase();
    return (node?.bond_providers?.providers || []).find((provider) => (
      String(provider?.bond_address || '').toLowerCase() === target
    ));
  }

  function getBondNodesFromThorNodes(nodes, bondAddress) {
    return (Array.isArray(nodes) ? nodes : [])
      .map((node) => {
        const provider = getBondProviderForAddress(node, bondAddress);
        const bond = Number(provider?.bond || 0);
        if (!provider || bond <= 1e8) {
          return null;
        }

        return {
          address: node.node_address,
          bond: String(provider.bond || '0'),
          status: node.status || ''
        };
      })
      .filter(Boolean);
  }

  const fetchBtcPoolData = async () => {
    try {
      const btcPoolData = await thornode.getPool('BTC.BTC');
      const balanceAsset = btcPoolData.balance_asset;
      const balanceRune = btcPoolData.balance_rune;
      const btcruneprice = balanceAsset / balanceRune;
      bondvaluebtc = (my_bond * btcruneprice) / 1e8;
    } catch (error) {
      console.error("Error fetching BTC pool data:", error);
    }
  };

  const fetchBondData = async () => {
    try {
      isLoading = true;
      showContent = false;

      // Discover current bond nodes from THORNode instead of Midgard /bonds,
      // which has been intermittently returning 500s in browser traffic.
      const allNodesData = await getNodes({ cache: false });
      allNodes = allNodesData;
      const nodesWithBond = getBondNodesFromThorNodes(allNodesData, my_bond_address);

      if (nodesWithBond.length === 0) {
        throw new Error('No active bonds found for this address');
      }
      
      if (nodesWithBond.length === 1) {
        // Single node - use existing UI
        isMultiNode = false;
        const singleNode = nodesWithBond[0];
        node_address = singleNode.address;
        nodeAddressSuffix = getAddressSuffix(node_address, 4);
        await fetchData(allNodesData);
      } else if (nodesWithBond.length > 1) {
        // Multiple nodes - use new UI
        isMultiNode = true;
        await fetchMultiNodeData(nodesWithBond, allNodesData);
      }
      
      // Data loaded, start transition
      isLoading = false;
      setTimeout(() => {
        showContent = true;
      }, 200);

      // Auto-load bond history
      if (!historyLoaded && !historyLoading) {
        fetchBondHistory();
      }
    } catch (error) {
      console.error("Error fetching bond data:", error);
      isLoading = false;
      showContent = true;
      if (!historyLoaded && !historyLoading) {
        fetchBondHistory();
      }
    }
  };

  const fetchMultiNodeData = async (nodes, preloadedAllNodes = null) => {
    try {
      // Fetch common data first
      const [churnState, runePriceData, btcPoolData, allNodesData] = await Promise.all([
        getChurnState().catch(() => null),
        thornode.getNetwork(),
        thornode.getPool('BTC.BTC'),
        preloadedAllNodes || getNodes()
      ]);

      allNodes = allNodesData;
      recentChurnTimestamp = churnState?.lastChurnTimestamp || 0;
      runePriceUSD = fromBaseUnit(runePriceData.rune_price_in_tor);
      const churnEstimate = getChurnEstimateInput(churnState);

      const balanceAsset = btcPoolData.balance_asset;
      const balanceRune = btcPoolData.balance_rune;
      const btcruneprice = balanceAsset / balanceRune;

      // Fetch detailed data for each node
      const nodeDataPromises = nodes.map(async (node) => {
        const nodeData = await thornode.fetch(`/thorchain/node/${node.address}`);
        const bondProviders = nodeData.bond_providers.providers;

        let userBond = 0;
        let totalBond = 0;

        for (const provider of bondProviders) {
          if (provider.bond_address === my_bond_address) {
            userBond = Number(provider.bond);
          }
          totalBond += Number(provider.bond);
        }

        const bondOwnershipPercentage = userBond / totalBond;
        const nodeOperatorFee = Number(nodeData.bond_providers.node_operator_fee) / 10000;
        const currentAward = Number(nodeData.current_award) * (1 - nodeOperatorFee);
        const userAward = bondOwnershipPercentage * currentAward;

        // Get leave status for churn indicator
        const fullNodeData = allNodes.find(n => n.node_address === node.address);
        const nodeLeaveStatus = fullNodeData ? getLeaveStatus(fullNodeData, allNodes) : null;
        const nodeForcedToLeave = fullNodeData?.forced_to_leave || false;

        return {
          address: node.address,
          addressSuffix: getAddressSuffix(node.address, 4),
          status: nodeData.status,
          bond: userBond,
          award: userAward,
          fee: nodeOperatorFee,
          bondFormatted: simplifyNumber(fromBaseUnit(userBond)),
          bondFullAmount: Math.round(userBond / 1e8),
          btcValue: (userBond * btcruneprice) / 1e8,
          leaveStatus: nodeLeaveStatus,
          forcedToLeave: nodeForcedToLeave
        };
      });

      const resolvedBondNodes = await Promise.all(nodeDataPromises);

      applyChurnInfo(churnState);

      bondNodes = resolvedBondNodes.map((node) => ({
        ...node,
        apy: estimateCurrentChurnYields({
          reward: node.award,
          principal: node.bond,
          ...churnEstimate
        }).apy
      }));
      
      // Calculate totals
      totalBond = bondNodes.reduce((sum, node) => sum + node.bond, 0);
      totalAward = bondNodes.reduce((sum, node) => sum + node.award, 0);
      
      aggregateAPY = estimateCurrentChurnYields({
        reward: totalAward,
        principal: totalBond,
        ...churnEstimate
      }).apy;
      
      // Update legacy variables for existing reactive statements
      my_bond = totalBond;
      my_award = totalAward;
      APY = aggregateAPY;
      bondvaluebtc = bondNodes.reduce((sum, node) => sum + node.btcValue, 0);
      
    } catch (error) {
      console.error("Error fetching multi-node data:", error);
    }
  };

  const fetchData = async (preloadedAllNodes = null) => {
    try {
      // Parallelize independent API calls
      const [nodeData, churnState, runePriceData, allNodesData] = await Promise.all([
        thornode.fetch(`/thorchain/node/${node_address}`),
        getChurnState().catch(() => null),
        thornode.getNetwork(),
        preloadedAllNodes || getNodes()
      ]);

      allNodes = allNodesData;

      // Process node data
      nodeStatus = nodeData.status;

      // Check leave status for churn indicator
      const fullNodeData = allNodes.find(n => n.node_address === node_address);
      if (fullNodeData) {
        leaveStatus = getLeaveStatus(fullNodeData, allNodes);
        forcedToLeave = fullNodeData.forced_to_leave || false;
      } else {
        leaveStatus = null;
        forcedToLeave = false;
      }
      const bondProviders = nodeData.bond_providers.providers;
      let total_bond = 0;
      for (const provider of bondProviders) {
        if (provider.bond_address === my_bond_address) my_bond = Number(provider.bond);
        total_bond += Number(provider.bond);
      }
      my_bond_ownership_percentage = my_bond / total_bond;
      nodeOperatorFee = Number(nodeData.bond_providers.node_operator_fee) / 10000;
      current_award = Number(nodeData.current_award) * (1 - nodeOperatorFee);
      my_award = my_bond_ownership_percentage * current_award;

      // Process churn data for APY calculation
      recentChurnTimestamp = churnState?.lastChurnTimestamp || 0;
      const churnEstimate = getChurnEstimateInput(churnState);
      applyChurnInfo(churnState);
      APY = estimateCurrentChurnYields({
        reward: my_award,
        principal: my_bond,
        ...churnEstimate
      }).apy;

      // Process price data
      runePriceUSD = fromBaseUnit(runePriceData.rune_price_in_tor);

      // Fetch additional data (these also run in parallel with each other)
      fetchBtcPoolData();
    } catch (error) {
      console.error("Error fetching or processing data:", error);
    }
  };

  // Map churn height → array of bond/unbond tx hashes from the backend cache.
  let bondTxMap = {};

  const BOND_HISTORY_API = {
    base: (import.meta.env.VITE_NODEOP_API_BASE || '').replace(/\/$/, ''),
    key: import.meta.env.VITE_NODEOP_API_KEY || ''
  };

  const fetchBondHistory = async () => {
    try {
      historyLoading = true;
      historyError = null;
      historyProgressCurrent = 0;
      historyProgressTotal = 1; // indeterminate

      // Call the edge function — it handles caching, archive queries, everything
      const histParam = includeHistorical ? '&include_historical=true' : '';
      const url = `${BOND_HISTORY_API.base}/bond-history?bond_address=${encodeURIComponent(my_bond_address)}${histParam}&include_bond_txs=true`;
      const res = await fetch(url, {
        headers: {
          'apikey': BOND_HISTORY_API.key,
          'Authorization': `Bearer ${BOND_HISTORY_API.key}`
        }
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `API error ${res.status}`);
      }

      const data = await res.json();
      const history = data.history || [];
      hasHistoricalNodes = data.has_historical || false;
      bondTxMap = data.bond_tx_map || {};

      // Transform into chart-ready format
      const results = history.map(row => ({
        height: row.churn_height,
        timestampSec: row.churn_timestamp,
        date: new Date(row.churn_timestamp * 1000),
        runeStack: row.rune_stack,
        userBond: row.user_bond != null ? row.user_bond : null,
        usdValue: (row.rune_stack / 1e8) * row.rune_price,
        runePrice: row.rune_price,
        ratesJson: row.rates_json || null
      }));

      // Calculate per-churn earnings, reward vs bond change, and APY
      churnHistory = results.map((entry, idx) => {
        if (idx === 0) {
          return { ...entry, earned: 0, reward: 0, bondChange: 0, apy: 0 };
        }
        const prev = results[idx - 1];
        const earned = entry.runeStack - prev.runeStack;

        // Decompose: reward = pending reward this period, bondChange = manual bond/unbond
        let reward = earned;
        let bondChange = 0;
        if (entry.userBond != null) {
          reward = entry.runeStack - entry.userBond;  // pending reward at this snapshot
          bondChange = entry.userBond - prev.runeStack; // bond events (prev rune_stack included prev reward, which was folded into bond)
        }

        // APY based on reward only (not bond events)
        const timeDiff = entry.timestampSec - prev.timestampSec;
        const apr = prev.runeStack > 0 ? calculateAPR(reward, prev.runeStack, timeDiff) : 0;
        const apy = calculateAPY(apr);
        return { ...entry, earned, reward, bondChange, apy };
      });

      historyLoaded = true;
      historyLoading = false;

      // Pre-fetch historical rates for current currency if not USD
      const curr = get(currentCurrency);
      if (curr !== 'USD') loadHistoricalRates(curr);

      // Render chart on next tick
      setTimeout(() => initHistoryChart(), 0);
    } catch (error) {
      console.error('Error fetching bond history:', error);
      historyError = error.message;
      historyLoading = false;
    }
  };

  // ---- Currency conversion helpers ----

  async function loadHistoricalRates(currency) {
    if (currency === 'USD' || historicalRatesCache[currency]) return;
    if (!churnHistory.length) return;

    currencyLoading = true;
    const fromTs = churnHistory[0].timestampSec;
    const toTs = Math.floor(Date.now() / 1000);
    const points = await fetchHistoricalRates(currency, fromTs, toTs);
    historicalRatesCache[currency] = points;
    currencyLoading = false;

    // Re-render chart with new data
    initHistoryChart();
  }

  /**
   * Convert a USD value at a specific churn entry to the current currency.
   * Priority: DB-stored rate → on-demand historical rate → current rate
   */
  function convertChurnValue(usdValue, entry, currency, rates) {
    if (currency === 'USD') return usdValue;
    if (!rates.USD) return usdValue;

    const isFiat = ['EUR', 'GBP', 'JPY'].includes(currency);

    // 1. Try DB-stored rate
    if (entry.ratesJson) {
      if (isFiat && entry.ratesJson[currency] && entry.runePrice > 0) {
        // ratesJson stores RUNE price in that fiat directly
        const fiatRate = entry.ratesJson[currency];
        return usdValue * (fiatRate / (entry.runePrice)); // runePrice is RUNE/USD
      }
      // For crypto/stocks: ratesJson stores USD price of asset or RUNE price in asset
      const assetUsdKey = currency + '_USD';
      if (entry.ratesJson[assetUsdKey]) {
        return usdValue / entry.ratesJson[assetUsdKey];
      }
      if (entry.ratesJson[currency]) {
        // Could be RUNE price in that currency
        return usdValue * (entry.ratesJson[currency] / entry.runePrice);
      }
    }

    // 2. Try on-demand historical rate
    const points = historicalRatesCache[currency];
    if (points && points.length > 0) {
      if (isFiat) {
        const rate = interpolateRate(points, entry.timestampSec, true);
        if (rate && rate.fiat && rate.usd) {
          return usdValue * (rate.fiat / rate.usd);
        }
      } else {
        const assetUsdPrice = interpolateRate(points, entry.timestampSec, false);
        if (assetUsdPrice && assetUsdPrice > 0) {
          return usdValue / assetUsdPrice;
        }
      }
    }

    // 3. Fallback to current rate
    if (rates[currency]) {
      return usdValue * (rates[currency] / rates.USD);
    }

    return usdValue;
  }

  // Reactive: when currency changes, load historical rates and re-render chart
  $: if (historyLoaded && $currentCurrency !== 'USD') {
    loadHistoricalRates($currentCurrency);
  }
  $: if (historyLoaded && $currentCurrency && $exchangeRates) {
    setTimeout(() => initHistoryChart(), 0);
  }

  const initHistoryChart = () => {
    if (!historyChartCanvas || churnHistory.length === 0) return;

    const ctx = historyChartCanvas.getContext('2d');
    if (historyChartInstance) {
      historyChartInstance.destroy();
    }

    const curr = get(currentCurrency);
    const rates = get(exchangeRates);
    const config = currencyConfig[curr] || currencyConfig.USD;
    const sym = getCurrencySymbol(curr);

    const labels = churnHistory.map(c =>
      c.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    );
    const runeData = churnHistory.map(c => fromBaseUnit(c.runeStack));
    const valueData = churnHistory.map(c => convertChurnValue(c.usdValue, c, curr, rates));

    // Bond event markers: per-point styling
    const bondEvents = churnHistory.map(c => {
      const bc = c.bondChange || 0;
      return Math.abs(bc) >= 1e7 ? bc : 0;
    });
    const runePointBg = bondEvents.map(bc => bc > 0 ? '#5588cc' : bc < 0 ? '#cc4444' : '#00cc66');
    const runePointBorder = bondEvents.map(bc => bc > 0 ? '#5588cc' : bc < 0 ? '#cc4444' : '#00cc66');

    // Plugin to label the last point on each dataset
    const lastPointLabel = {
      id: 'lastPointLabel',
      afterDatasetsDraw(chart) {
        const { ctx: c } = chart;
        chart.data.datasets.forEach((dataset, i) => {
          const meta = chart.getDatasetMeta(i);
          const lastPoint = meta.data[meta.data.length - 1];
          if (!lastPoint) return;
          const value = dataset.data[dataset.data.length - 1];
          const isRune = dataset.yAxisID === 'y';
          const text = isRune
            ? formatNumber(value, { maximumFractionDigits: 0 }) + ' ᚱ'
            : sym + formatNumber(value, { maximumFractionDigits: config.decimals });
          c.save();
          c.font = "600 10px 'JetBrains Mono', monospace";
          c.fillStyle = isRune ? '#00cc66' : '#d4a017';
          c.textAlign = isRune ? 'left' : 'right';
          const xOff = isRune ? -c.measureText(text).width - 8 : 8;
          c.fillText(text, lastPoint.x + xOff, lastPoint.y - 8);
          c.restore();
        });
      }
    };

    historyChartInstance = new Chart(ctx, {
      type: 'line',
      plugins: [lastPointLabel],
      data: {
        labels,
        datasets: [
          {
            label: 'RUNE STACK',
            data: runeData,
            borderColor: '#00cc66',
            backgroundColor: 'rgba(0, 204, 102, 0.05)',
            fill: true,
            tension: 0.2,
            yAxisID: 'y',
            pointRadius: 2,
            pointHoverRadius: 5,
            pointBackgroundColor: runePointBg,
            pointBorderColor: runePointBorder,
            pointBorderWidth: 0,
            borderWidth: 1.5,
            segment: {
              borderColor: (ctx) => {
                const bc = bondEvents[ctx.p1DataIndex];
                if (bc > 0) return '#5588cc';
                if (bc < 0) return '#cc4444';
                return undefined;
              },
              borderWidth: (ctx) => bondEvents[ctx.p1DataIndex] !== 0 ? 2.5 : undefined
            }
          },
          {
            label: curr + ' VALUE',
            data: valueData,
            borderColor: '#d4a017',
            backgroundColor: 'rgba(212, 160, 23, 0.05)',
            fill: true,
            tension: 0.2,
            yAxisID: 'y1',
            pointRadius: 2,
            pointHoverRadius: 5,
            pointBackgroundColor: '#d4a017',
            borderWidth: 1.5
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
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.04)', lineWidth: 0.5 },
            ticks: { color: '#444', font: { family: "'JetBrains Mono', monospace", size: 10 } },
            border: { color: '#1a1a1a' }
          },
          y: {
            type: 'linear',
            position: 'left',
            grid: { color: 'rgba(255, 255, 255, 0.04)', lineWidth: 0.5 },
            border: { color: '#1a1a1a' },
            ticks: {
              color: '#00cc66',
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              callback: (v) => simplifyNumber(v) + ' ᚱ'
            }
          },
          y1: {
            type: 'linear',
            position: 'right',
            grid: { drawOnChartArea: false },
            border: { color: '#1a1a1a' },
            ticks: {
              color: '#d4a017',
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              callback: (v) => formatCurrencyCompact(v, curr)
            }
          }
        },
        plugins: {
          legend: {
            labels: {
              color: '#555',
              font: { family: "'JetBrains Mono', monospace", size: 10, weight: '600' },
              boxWidth: 12,
              boxHeight: 2,
              padding: 16
            }
          },
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
              label: (context) => {
                const val = context.raw;
                if (context.dataset.yAxisID === 'y') {
                  return ' ᚱ ' + formatNumber(val, { maximumFractionDigits: 1 });
                }
                return ' ' + sym + formatNumber(val, { maximumFractionDigits: config.decimals });
              },
              afterBody: (tooltipItems) => {
                if (!tooltipItems.length) return '';
                const idx = tooltipItems[0].dataIndex;
                const bc = bondEvents[idx];
                if (bc === 0) return '';
                const runeAmt = fromBaseUnit(Math.abs(bc));
                const label = bc > 0 ? 'BOND ADD' : 'BOND REMOVE';
                return '\n ' + label + ': ' + (bc > 0 ? '+' : '-') + formatNumber(runeAmt, { maximumFractionDigits: 1 }) + ' ᚱ';
              }
            }
          }
        },
        animation: {
          duration: 400,
          easing: 'easeOutQuart'
        }
      }
    });
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (my_bond_address) {
      bondAddressSuffix = getAddressSuffix(my_bond_address, 4);
      showData = true;
      updateURLBondOnly();
      localStorage.setItem('bond_tracker_address', my_bond_address);
      fetchBondData();
    }
  };

  const switchAddress = () => {
    showData = false;
    my_bond_address = '';
    churnHistory = [];
    historyLoaded = false;
    churnPage = 1;
    if (historyChartInstance) { historyChartInstance.destroy(); historyChartInstance = null; }
    const url = new URL(window.location);
    url.searchParams.delete('bond_address');
    window.history.pushState({}, '', url);
  };

  function buildChurnCsvRows() {
    return churnReversed.map(c => ({
      date: c.date.toISOString().slice(0, 10),
      reward_rune: (c.reward / 1e8).toFixed(4),
      bond_change_rune: (c.bondChange / 1e8).toFixed(4),
      apy_pct: (c.apy * 100).toFixed(2),
      stack_rune: (c.runeStack / 1e8).toFixed(4),
      rune_price_usd: c.runePrice.toFixed(4),
      usd_value: c.usdValue.toFixed(2)
    }));
  }

  function downloadCSV() {
    const rows = buildChurnCsvRows();
    const headers = Object.keys(rows[0]);
    const csv = [headers.join(','), ...rows.map(r => headers.map(h => r[h]).join(','))].join('\n');
    downloadFile(csv, `bond-churns-${bondAddressSuffix}.csv`, 'text/csv');
  }

  function downloadXLS() {
    // Tab-separated values with .xls extension — opens in Excel
    const rows = buildChurnCsvRows();
    const headers = Object.keys(rows[0]);
    const tsv = [headers.join('\t'), ...rows.map(r => headers.map(h => r[h]).join('\t'))].join('\n');
    downloadFile(tsv, `bond-churns-${bondAddressSuffix}.xls`, 'application/vnd.ms-excel');
  }

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const updateURLBondOnly = () => {
    const url = new URL(window.location);
    url.searchParams.set("bond_address", my_bond_address);
    url.searchParams.delete("node_address");
    const curr = get(currentCurrency);
    if (curr !== 'USD') {
      url.searchParams.set("currency", curr);
    } else {
      url.searchParams.delete("currency");
    }
    window.history.pushState({}, '', url);
  };

  let showToast = false;
  let toastMessage = "";

  const openRuneScan = () => {
    window.open(`https://thorchain.net/address/${my_bond_address}`, '_blank');
  };

  const showToastMessage = (message) => {
    toastMessage = message;
    showToast = true;
  };

  // Update other functions to use showToastMessage
  const copyLink = () => {
    const url = new URL(window.location);
    url.searchParams.set("bond_address", my_bond_address);
    if (!isMultiNode && node_address) {
      url.searchParams.set("node_address", node_address);
    } else {
      url.searchParams.delete("node_address");
    }
    const currVal = get(currentCurrency);
    if (currVal !== 'USD') {
      url.searchParams.set("currency", currVal);
    } else {
      url.searchParams.delete("currency");
    }
    navigator.clipboard.writeText(url.toString()).then(() => {
      showToastMessage("Link copied to clipboard!");
    });
  };

  const addBookmark = () => {
    if (isMobile) {
      if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
        showToastMessage("To add to home screen: tap the share icon, then 'Add to Home Screen'.");
      } else if (/Android/.test(navigator.userAgent)) {
        showToastMessage("To add to home screen: tap the menu icon, then 'Add to Home Screen'.");
      } else {
        showToastMessage("To add to home screen, check your browser's options or menu.");
      }
    } else {
      showToastMessage("Press " + (navigator.userAgent.toLowerCase().indexOf('mac') != -1 ? 'Cmd' : 'Ctrl') + "+D to bookmark this page.");
    }
  };

  async function pickRandomNode() {
    try {
      const nodes = await thornode.getNodes();
      const activeNodes = nodes.filter(node => node.status === 'Active');
      if (activeNodes.length === 0) {
        throw new Error('No active nodes found');
      }

      const randomNode = activeNodes[Math.floor(Math.random() * activeNodes.length)];
      const bondProviders = randomNode.bond_providers.providers;
      const randomBondProvider = bondProviders[Math.floor(Math.random() * bondProviders.length)];

      my_bond_address = randomBondProvider.bond_address;

      // Update suffix and URL
      bondAddressSuffix = getAddressSuffix(my_bond_address, 4);
      const url = new URL(window.location);
      url.searchParams.set('bond_address', my_bond_address);
      url.searchParams.delete('node_address'); // Let fetchBondData determine the node
      window.history.pushState({}, '', url);

      // Use the standard data flow which handles single/multi-node detection
      showData = true;
      await fetchBondData();
    } catch (error) {
      console.error('Error picking random node:', error);
    }
  }

  onMount(async () => {
    isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    await initCurrency(); // Initialize currency from URL and fetch exchange rates
    updateAddressesFromURL();
  });

  onDestroy(() => {
    if (historyChartInstance) {
      historyChartInstance.destroy();
    }
  });
</script>

<div class="bt">
  {#if !showData}
    <!-- Entry form -->
    <div class="entry">
      <form on:submit={handleSubmit}>
        <div class="entry-label">BOND ADDRESS</div>
        <div class="entry-row">
          <input type="text" bind:value={my_bond_address} required placeholder="thor1..." />
          <button type="submit">TRACK</button>
          <button type="button" class="dice-btn" on:click={pickRandomNode} title="Random">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect>
              <circle cx="8.5" cy="8.5" r="1.5"></circle>
              <circle cx="15.5" cy="15.5" r="1.5"></circle>
            </svg>
          </button>
        </div>
      </form>
    </div>
  {:else}
    <!-- Metrics strip -->
    <div class="metrics">
      <div class="metric">
        <div class="metric-val accent">{showContent ? formatNumber(my_bond / 1e8, { maximumFractionDigits: 1 }) : '--'}</div>
        <div class="metric-key">BOND ᚱ</div>
        <div class="metric-sub">{showContent ? formattedBondValue : ''}</div>
      </div>
      <div class="metric">
        <div class="metric-val">{showContent ? formatNumber(my_award / 1e8, { maximumFractionDigits: 1 }) : '--'}</div>
        <div class="metric-key">NEXT AWARD ᚱ</div>
        <div class="metric-sub">{showContent ? formattedNextAward : ''}</div>
      </div>
      <div class="metric">
        <div class="metric-val amber">{showContent && totalRewardsRune > 0 ? '+' + formatNumber(totalRewardsRune / 1e8, { maximumFractionDigits: 1 }) : '--'}</div>
        <div class="metric-key">TOTAL EARNED ᚱ</div>
        <div class="metric-sub">{showContent && totalRewardsRune > 0 ? formattedTotalRewards + ' · ' + (churnHistory[0]?.runeStack > 0 ? ((totalRewardsRune / churnHistory[0].runeStack) * 100).toFixed(1) : '0') + '%' : ''}</div>
      </div>
      <div class="metric">
        <div class="metric-val {netBondChangeRune > 0 ? 'blue' : netBondChangeRune < 0 ? 'red' : ''}">{showContent && netBondChangeRune !== 0 ? (netBondChangeRune > 0 ? '+' : '') + formatNumber(netBondChangeRune / 1e8, { maximumFractionDigits: 1 }) : showContent ? '0' : '--'}</div>
        <div class="metric-key">NET BOND/UNBOND</div>
        <div class="metric-sub">{showContent && netBondChangeRune !== 0 ? formattedNetBondChange : ''}</div>
      </div>
      <div class="metric">
        <div class="metric-val accent">{showContent ? (APY * 100).toFixed(2) + '%' : '--'}</div>
        <div class="metric-key">APY</div>
        <div class="metric-sub">{showContent ? formattedAPY + '/yr' : ''}</div>
      </div>
      <div class="metric">
        <div class="metric-val">{showContent ? formattedRunePrice : '--'}</div>
        <div class="metric-key">RUNE PRICE</div>
      </div>
      <div class="metric">
        <div class="metric-val amber">{showContent ? countdown || '--' : '--'}</div>
        <div class="metric-key">NEXT CHURN</div>
        {#if isChurningHalted}<div class="metric-sub warn">HALTED</div>{/if}
      </div>
      <div class="metric">
        {#if !isMultiNode}
          <div class="metric-val">{showContent ? (nodeOperatorFee * 100).toFixed(1) + '%' : '--'}</div>
          <div class="metric-key">NODE FEE</div>
          <div class="metric-sub"><a class="node-link" href="https://thorchain.net/node/{node_address}" target="_blank" rel="noreferrer">{nodeAddressSuffix}</a> <button class="change-btn" on:click={switchAddress}>change</button></div>
        {:else}
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <div class="metric-val metric-val--clickable" on:click={() => showNodeListModal = !showNodeListModal}>{showContent ? bondNodes.length : '--'}</div>
          <div class="metric-key">NODES</div>
          <div class="metric-sub">{bondAddressSuffix} <button class="change-btn" on:click={switchAddress}>change</button></div>
          {#if showNodeListModal}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <div class="node-list-backdrop" on:click={() => showNodeListModal = false}></div>
            <div class="node-list-modal">
              {#each bondNodes as node}
                <a class="node-list-item" href="https://thorchain.net/node/{node.address}" target="_blank" rel="noreferrer">
                  <span class="node-list-addr">{node.addressSuffix}</span>
                  <span class="status-badge" class:active={node.status === 'Active'} class:standby={node.status !== 'Active'}>{node.status}</span>
                  <span class="node-list-bond">{node.bondFormatted} ᚱ</span>
                </a>
              {/each}
            </div>
          {/if}
        {/if}
      </div>
    </div>

    <!-- Chart section -->
    <section class="data-section">
      <div class="section-head">
        <h3>BOND HISTORY</h3>
        <span class="section-sub">
          {#if historyLoading}
            Loading history...
          {:else if historyLoaded}
            Last {churnHistory.length} churns
          {:else}
            --
          {/if}
        </span>
        <span class="section-actions">
          {#if hasHistoricalNodes}
            <button
              class="hist-toggle"
              class:active={includeHistorical}
              title="Include bond history from previous (no longer active) nodes"
              on:click={() => { includeHistorical = !includeHistorical; fetchBondHistory(); }}
            >HIST</button>
          {/if}
          <CurrencySelector />
          <button class="icon-btn" on:click={fetchBondData} title="Refresh"><RefreshIcon size={14} /></button>
          <button class="icon-btn" on:click={copyLink} title="Copy Link"><CopyIcon size={14} /></button>
          <button class="icon-btn" on:click={openRuneScan} title="RuneScan">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15,3 21,3 21,9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
          </button>
        </span>
      </div>

      <div class="chart-area">
        {#if historyLoading}
          <div class="chart-loading">
            <div class="progress-bar"><div class="progress-fill indeterminate"></div></div>
          </div>
        {:else if historyError}
          <div class="chart-msg err">{historyError}</div>
        {:else if !historyLoaded}
          <div class="chart-msg dim">Loading bond history...</div>
        {/if}
        <canvas bind:this={historyChartCanvas} class:hidden={!historyLoaded}></canvas>
      </div>
    </section>

    <!-- Churn earnings table -->
    <section class="data-section">
      <div class="section-head">
        <h3>CHURN EARNINGS</h3>
        <span class="section-sub">{churnReversed.length} churns</span>
        {#if historyLoaded && churnReversed.length > 0}
          <span class="section-actions">
            <button class="icon-btn dl-btn" on:click={downloadCSV} title="Download CSV">.csv</button>
            <button class="icon-btn dl-btn" on:click={downloadXLS} title="Download XLS">.xls</button>
          </span>
        {/if}
      </div>

      {#if !historyLoaded}
        <div class="empty dim">{historyLoading ? 'Loading...' : 'Waiting for history data...'}</div>
      {:else}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>DATE</th>
                <th class="right">REWARD ᚱ</th>
                <th class="right">BOND ±</th>
                <th class="right">{$currentCurrency}</th>
                <th class="right">APY</th>
                <th class="right">STACK ᚱ</th>
              </tr>
            </thead>
            <tbody>
              {#each churnPaged as churn}
                <tr>
                  <td class="mono">{churn.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                  <td class="mono right {churn.reward > 0 ? 'accent' : ''}">{churn.reward > 0 ? '+' : ''}{formatNumber(fromBaseUnit(churn.reward), { maximumFractionDigits: 2 })}</td>
                  <td class="mono right {Math.abs(churn.bondChange) >= 1e7 ? (churn.bondChange > 0 ? 'blue' : 'red') : 'dim'}">{#if Math.abs(churn.bondChange) >= 1e7}{#if bondTxMap[churn.height]}<a class="bond-tx-link {churn.bondChange > 0 ? 'blue' : 'red'}" href="https://thorchain.net/tx/{bondTxMap[churn.height][0]}" target="_blank" rel="noopener noreferrer">{churn.bondChange > 0 ? '+' : ''}{formatNumber(fromBaseUnit(churn.bondChange), { maximumFractionDigits: 0 })}</a>{:else}{churn.bondChange > 0 ? '+' : ''}{formatNumber(fromBaseUnit(churn.bondChange), { maximumFractionDigits: 0 })}{/if}{:else}--{/if}</td>
                  <td class="mono right dim">{getCurrencySymbol($currentCurrency)}{formatNumber(convertChurnValue(fromBaseUnit(churn.reward) * churn.runePrice, churn, $currentCurrency, $exchangeRates), { maximumFractionDigits: (currencyConfig[$currentCurrency] || {}).decimals || 0 })}</td>
                  <td class="mono right {churn.apy > 0.15 ? 'accent' : ''}">{(churn.apy * 100).toFixed(1)}%</td>
                  <td class="mono right">{formatNumber(fromBaseUnit(churn.runeStack), { maximumFractionDigits: 0 })}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        {#if churnTotalPages > 1}
          <div class="pagination">
            <button class="page-btn" disabled={churnPage <= 1} on:click={() => churnPage--}>Prev</button>
            {#each Array(churnTotalPages) as _, i}
              {#if churnTotalPages <= 7 || i === 0 || i === churnTotalPages - 1 || Math.abs(i + 1 - churnPage) <= 1}
                <button class="page-btn" class:page-active={churnPage === i + 1} on:click={() => churnPage = i + 1}>{i + 1}</button>
              {:else if i === 1 && churnPage > 3}
                <span class="page-dots">...</span>
              {:else if i === churnTotalPages - 2 && churnPage < churnTotalPages - 2}
                <span class="page-dots">...</span>
              {/if}
            {/each}
            <button class="page-btn" disabled={churnPage >= churnTotalPages} on:click={() => churnPage++}>Next</button>
          </div>
        {/if}
      {/if}
    </section>

    <!-- Multi-node detail -->
    {#if isMultiNode && showContent}
      <section class="data-section">
        <div class="section-head">
          <h3>NODES</h3>
          <span class="section-sub">{bondNodes.length} active bonds</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>NODE</th>
                <th>STATUS</th>
                <th class="right">BOND ᚱ</th>
                <th class="right">APY</th>
                <th class="right">FEE</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each bondNodes as node}
                <tr>
                  <td class="mono">{node.addressSuffix}</td>
                  <td>
                    <span class="status-badge" class:active={node.status === 'Active'} class:standby={node.status !== 'Active'}>
                      {node.status}
                    </span>
                    {#if node.forcedToLeave || node.leaveStatus}
                      <span class="churn-tag">{getChurnReason(node.leaveStatus, node.forcedToLeave)}</span>
                    {/if}
                  </td>
                  <td class="mono right accent">{formatNumber(node.bondFullAmount)}</td>
                  <td class="mono right">{(node.apy * 100).toFixed(1)}%</td>
                  <td class="mono right dim">{(node.fee * 100).toFixed(1)}%</td>
                  <td><a href="https://thorchain.net/node/{node.address}" target="_blank" rel="noreferrer">{node.addressSuffix}</a></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}
  {/if}
</div>

<Toast
  message={toastMessage}
  visible={showToast}
  duration={2000}
  on:hide={() => showToast = false}
/>

<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap');

  .bt {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0;
    font-family: 'DM Sans', -apple-system, sans-serif;
    color: #c8c8c8;
  }

  /* ---- ENTRY FORM ---- */
  .entry {
    max-width: 560px;
    margin: 80px auto;
    padding: 0 16px;
  }

  .entry-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: #555;
    text-transform: uppercase;
    margin-bottom: 8px;
  }

  .entry-row {
    display: flex;
    gap: 8px;
  }

  .entry-row input {
    flex: 1;
    background: #0d0d0d;
    border: 1px solid #1a1a1a;
    color: #e0e0e0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    padding: 12px 14px;
    border-radius: 0;
    outline: none;
    transition: border-color 0.15s;
  }

  .entry-row input:focus {
    border-color: #00cc66;
  }

  .entry-row input::placeholder {
    color: #333;
  }

  .entry-row button[type="submit"] {
    background: #00cc66;
    color: #000;
    border: none;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    padding: 12px 20px;
    cursor: pointer;
    border-radius: 0;
    transition: background 0.15s;
  }

  .entry-row button[type="submit"]:hover {
    background: #00e070;
  }

  .dice-btn {
    background: #1a1a1a;
    border: 1px solid #333;
    color: #666;
    padding: 12px;
    cursor: pointer;
    border-radius: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }

  .dice-btn:hover {
    border-color: #00cc66;
    color: #00cc66;
  }

  /* ---- METRICS ---- */
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    border-bottom: 1px solid #1a1a1a;
    background: #0d0d0d;
  }

  .metric {
    padding: 18px 16px;
    border-right: 1px solid #1a1a1a;
    text-align: center;
    position: relative;
  }

  .metric:last-child {
    border-right: none;
  }

  .metric-val {
    font-family: 'JetBrains Mono', monospace;
    font-size: 22px;
    font-weight: 700;
    color: #e0e0e0;
    letter-spacing: -0.02em;
    line-height: 1;
    margin-bottom: 6px;
  }

  .metric-val.accent {
    color: #00cc66;
  }

  .metric-val.amber {
    color: #d4a017;
  }

  .metric-val.blue {
    color: #5588cc;
  }

  .metric-val.red {
    color: #cc4444;
  }

  .metric-val--clickable {
    cursor: pointer;
    transition: color 0.15s;
  }
  .metric-val--clickable:hover {
    color: #5588cc;
  }

  .node-list-backdrop {
    position: fixed;
    inset: 0;
    z-index: 999;
  }

  .node-list-modal {
    position: absolute;
    top: calc(100% + 4px);
    left: 50%;
    transform: translateX(-50%);
    background: #111;
    border: 1px solid #2a2a2a;
    border-radius: 6px;
    padding: 4px;
    z-index: 1000;
    min-width: 13rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }

  .node-list-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
    text-decoration: none;
    color: #e0e0e0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    transition: background 0.1s;
  }
  .node-list-item:hover {
    background: #1a1a1a;
  }

  .node-list-addr {
    color: #5588cc;
  }

  .node-list-bond {
    margin-left: auto;
    color: #00cc66;
    white-space: nowrap;
  }

  .node-link {
    color: #5588cc;
    text-decoration: none;
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
  }

  .node-link:hover {
    color: #77aaee;
    text-decoration: underline;
  }

  .change-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: #555;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    margin-left: 4px;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .change-btn:hover {
    color: #00cc66;
  }

  /* Download buttons */
  .dl-btn {
    font-family: 'JetBrains Mono', monospace !important;
    font-size: 10px !important;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  /* Pagination */
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

  .metric-key {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: #999;
    text-transform: uppercase;
  }

  .metric-sub {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #888;
    margin-top: 4px;
  }

  .metric-sub.warn {
    color: #cc3333;
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
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #444;
  }

  .section-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .hist-toggle {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    padding: 3px 7px;
    background: none;
    border: 1px solid #333;
    color: #555;
    cursor: pointer;
    border-radius: 0;
    transition: all 0.15s;
    margin-right: 4px;
  }
  .hist-toggle:hover {
    color: #888;
    border-color: #444;
  }
  .hist-toggle.active {
    background: #00cc66;
    border-color: #00cc66;
    color: #000;
  }
  .hist-toggle.active:hover {
    background: #00e070;
    border-color: #00e070;
  }

  .icon-btn {
    background: none;
    border: 1px solid transparent;
    color: #555;
    cursor: pointer;
    padding: 4px 6px;
    display: flex;
    align-items: center;
    transition: all 0.15s;
    border-radius: 2px;
  }

  .icon-btn:hover {
    color: #00cc66;
    border-color: #333;
  }

  /* ---- CHART ---- */
  .chart-area {
    position: relative;
    height: 340px;
    padding: 12px 16px 8px;
    background: #0d0d0d;
  }

  .chart-area canvas {
    width: 100% !important;
    height: 100% !important;
  }

  .chart-area canvas.hidden {
    display: none;
  }

  .chart-loading {
    position: absolute;
    top: 50%;
    left: 16px;
    right: 16px;
    transform: translateY(-50%);
  }

  .chart-msg {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }

  .chart-msg.err {
    color: #cc4444;
  }

  .progress-bar {
    height: 2px;
    background: #1a1a1a;
    border-radius: 1px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: #00cc66;
    transition: width 0.3s ease;
  }

  .progress-fill.indeterminate {
    width: 30%;
    animation: indeterminate 1.5s ease-in-out infinite;
  }

  @keyframes indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(400%); }
  }

  /* ---- TABLES ---- */
  .table-wrap {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
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

  th.right { text-align: right; }

  td {
    padding: 9px 16px;
    font-size: 13px;
    border-bottom: 1px solid #111;
    color: #aaa;
    vertical-align: middle;
  }

  .mono {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }

  .dim { color: #555; }
  .right { text-align: right; }
  .accent { color: #00cc66; }
  .blue { color: #5588cc; }
  .red { color: #cc4444; }
  .bond-tx-link {
    text-decoration: none;
  }
  .bond-tx-link:hover {
    text-decoration: underline;
  }
  .bond-tx-link.blue { color: #5588cc; }
  .bond-tx-link.red { color: #cc4444; }

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

  .empty {
    padding: 24px 16px;
    color: #444;
    font-size: 13px;
    font-family: 'JetBrains Mono', monospace;
  }

  /* ---- NODE TABLE ---- */
  .status-badge {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    padding: 2px 6px;
    border-radius: 2px;
  }

  .status-badge.active {
    color: #00cc66;
    background: rgba(0, 204, 102, 0.1);
  }

  .status-badge.standby {
    color: #d4a017;
    background: rgba(212, 160, 23, 0.1);
  }

  .churn-tag {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: #cc3333;
    margin-left: 8px;
    letter-spacing: 0.06em;
  }

  /* ---- RESPONSIVE ---- */
  @media (max-width: 900px) {
    .metrics {
      grid-template-columns: repeat(3, 1fr);
    }

    .metric:nth-child(n+4) {
      border-top: 1px solid #1a1a1a;
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
      font-size: 18px;
    }

    .chart-area {
      height: 240px;
    }

    th, td {
      padding: 8px 10px;
    }

    .section-actions {
      display: none;
    }

    .section-actions:has(.dl-btn),
    .section-actions:has(.hist-toggle) {
      display: flex;
    }

    .entry {
      margin: 40px auto;
    }
  }
</style>
