<script>
  import { onMount, onDestroy } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { thornode } from './api/thornode.js';
  import {
    fetchDashboard,
    fetchPairOrders,
    fetchPairMarketHistory,
    fetchWalletPairOrders,
    fetchWalletTradeHistory,
    fetchLimitQuote
  } from './limit-orders/api.js';
  import {
    buildPoolPriceIndex,
    buildPairList,
    buildOrderBook,
    normalizeLimitSwap,
    getAssetPriceUSD,
    createCancelMemo,
    getOrderDisplayAmount,
    getOrderDisplayPrice,
    getOrderSideForPair,
    normalizeTradeActionForPair
  } from './limit-orders/model.js';
  import { fromBaseUnit, normalizeAsset, getChainFromAsset, normalizeAddress } from '$lib/utils/blockchain.js';
  import { copyToClipboard } from '$lib/utils/formatting.js';
  import ConnectWallet from './components/ConnectWallet.svelte';
  import ThorchainPairChart from './limit-orders/ThorchainPairChart.svelte';
  import { thorchainChartDataProvider } from './limit-orders/chart-data.js';
  import {
    walletAccounts,
    chainAssignments,
    tradeOwner,
    isWalletConnected,
    getAssignedAccount,
    getTradeOwnerAccount
  } from './limit-orders/store.js';

  // Lazy-load wallet module to avoid bloating the initial bundle
  let walletModule = null;
  async function getWalletModule() {
    if (!walletModule) {
      walletModule = await import('./limit-orders/wallet.js');
    }
    return walletModule;
  }

  // Data
  let summary = null;
  let pools = [];
  let inboundAddresses = [];
  let priceIndex = new Map();
  let pairList = [];
  let pairOrders = [];
  let walletPairOrders = [];
  let walletTradeActions = [];
  let normalizedWalletOrders = [];
  let orderBook = null;
  let openOrders = [];
  let filledOrders = [];
  let historyOrders = [];
  let visibleOrders = [];
  let marketHistoryRows = [];
  let connectedWalletAddresses = [];

  // UI State
  let selectedPair = null;
  let loading = true;
  let error = null;
  let loadingPairDetails = false;
  let loadingWalletActivity = false;
  let searchTerm = '';
  let bookFilter = 'all'; // 'all' | 'buy' | 'sell'
  let lastUpdated = null;

  // Toast
  let toastMessage = '';
  let toastVisible = false;
  let toastTimer = null;

  // Wallet
  let showWalletModal = false;

  // Order placement
  let placeOrderPrice = '';
  let placeOrderAmount = '';
  let placingOrder = false;
  let placeOrderError = '';
  let placeOrderSuccess = '';
  let destinationAddress = '';
  let destinationChain = '';
  let resolvedDestinationAddress = '';
  let lastAutoDestinationAddress = '';
  let lastDestinationChain = '';

  // Market order state
  let orderType = 'limit'; // 'limit' | 'market'
  let marketSlippage = 300; // basis points, default 3%
  let marketQuote = null;
  let marketQuoteLoading = false;
  let marketQuoteError = '';
  let marketQuoteTimer = null;

  // Memoless
  let memolessAssets = [];
  let memolessChannel = null;
  let creatingMemoless = false;
  let memolessError = '';

  // Cancel
  let cancellingTxId = null;

  // Polling
  let pollInterval;
  const POLL_INTERVAL_MS = 20000;
  const RPC_WS_URL = 'wss://rpc.thorchain.network/websocket';
  const RPC_RECONNECT_BASE_MS = 2000;
  const RPC_RECONNECT_MAX_MS = 30000;
  const REALTIME_REFRESH_DEBOUNCE_MS = 2500;
  let rpcWs = null;
  let rpcReconnectAttempt = 0;
  let rpcReconnectTimer = null;
  let realtimeRefreshTimer = null;
  let allowRpcReconnect = true;
  let rpcLastBlock = 0;

  onMount(async () => {
    allowRpcReconnect = true;
    await loadData();
    loadMemolessAssets();
    pollInterval = setInterval(() => loadData(true), POLL_INTERVAL_MS);
    connectRpcWs();
  });

  onDestroy(() => {
    allowRpcReconnect = false;
    if (pollInterval) clearInterval(pollInterval);
    if (toastTimer) clearTimeout(toastTimer);
    if (marketQuoteTimer) clearTimeout(marketQuoteTimer);
    if (realtimeRefreshTimer) clearTimeout(realtimeRefreshTimer);
    if (rpcReconnectTimer) clearTimeout(rpcReconnectTimer);
    disconnectRpcWs();
  });

  async function loadData(silent = false) {
    if (!silent) loading = true;
    error = null;
    try {
      const data = await fetchDashboard();
      summary = data.summary;
      pools = data.pools;
      inboundAddresses = data.inboundAddresses;
      priceIndex = buildPoolPriceIndex(pools, data.runePrice);
      pairList = buildPairList(pools, priceIndex, summary, inboundAddresses);
      lastUpdated = new Date();

      const nextSelectedPair = selectedPair
        ? pairList.find((pair) =>
            pair.sourceAsset === selectedPair.sourceAsset &&
            pair.targetAsset === selectedPair.targetAsset
          )
        : null;

      if (nextSelectedPair) {
        selectedPair = nextSelectedPair;
      } else if (pairList.length > 0) {
        selectedPair = pairList[0];
      } else {
        selectedPair = null;
      }

      if (selectedPair) {
        await refreshSelectedPairData(true);
      }
    } catch (err) {
      error = err.message;
    }
    loading = false;
  }

  async function loadPairOrders(pair, silent = false) {
    if (!silent) loadingPairDetails = true;
    try {
      const sourceAsset = pair?.sourceAsset ?? '';
      const targetAsset = pair?.targetAsset ?? '';
      const [nextPairOrders, nextMarketHistoryRows] = await Promise.all([
        fetchPairOrders(sourceAsset, targetAsset, {
          limit: 200,
          pairVariants: pair?.queuePairs ?? []
        }),
        fetchPairMarketHistory(sourceAsset, targetAsset, {
          limit: 50,
          fallbackSourcePriceUsd: pair?.sourcePriceUsd ?? null,
          fallbackTargetPriceUsd: pair?.targetPriceUsd ?? null,
          relevantAssets: pair?.historyAssets ?? []
        })
      ]);

      pairOrders = nextPairOrders;
      marketHistoryRows = nextMarketHistoryRows;
      orderBook = buildOrderBook(nextPairOrders, sourceAsset, targetAsset, priceIndex);
    } catch (err) {
      console.warn('Failed to load pair orders:', err);
      pairOrders = [];
      marketHistoryRows = [];
      orderBook = null;
    }
    loadingPairDetails = false;
  }

  async function loadWalletActivity(pair, silent = false) {
    if (!silent) loadingWalletActivity = true;

    if (connectedWalletAddresses.length === 0) {
      walletPairOrders = [];
      walletTradeActions = [];
      loadingWalletActivity = false;
      return;
    }

    try {
      const sourceAsset = pair?.sourceAsset ?? '';
      const targetAsset = pair?.targetAsset ?? '';
      const [nextWalletPairOrders, nextWalletTradeActions] = await Promise.all([
        fetchWalletPairOrders(connectedWalletAddresses, sourceAsset, targetAsset, { limit: 100 }),
        fetchWalletTradeHistory(connectedWalletAddresses, sourceAsset, targetAsset, {
          limit: 50,
          assetFilters: pair?.historyAssets ?? [sourceAsset, targetAsset]
        })
      ]);

      walletPairOrders = nextWalletPairOrders;
      walletTradeActions = nextWalletTradeActions;
    } catch (err) {
      console.warn('Failed to load wallet activity:', err);
      walletPairOrders = [];
      walletTradeActions = [];
    }

    loadingWalletActivity = false;
  }

  async function refreshSelectedPairData(silent = false) {
    if (!selectedPair) return;

    await Promise.all([
      loadPairOrders(selectedPair, silent),
      loadWalletActivity(selectedPair, silent)
    ]);
  }

  function selectPair(pair) {
    selectedPair = pair;
    refreshSelectedPairData();
  }

  function showToast(msg) {
    toastMessage = msg;
    toastVisible = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastVisible = false; }, 2500);
  }

  async function handleCopy(text, description) {
    const success = await copyToClipboard(text, description);
    if (success) {
      showToast(`Copied ${description}!`);
    }
  }

  function handleKeyActivate(event, callback) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      callback();
    }
  }

  function checkBlockForMarketRefresh(msg) {
    try {
      const data = msg.result?.data?.value;
      if (!data) return;

      const blockHeight = Number(data.block?.header?.height) || 0;
      if (!(blockHeight > 0) || blockHeight === rpcLastBlock) return;
      rpcLastBlock = blockHeight;

      const events = data.result_finalize_block?.events || data.result_end_block?.events || [];
      for (const event of events) {
        if (event?.type === 'swap' || event?.type === 'streaming_swap') {
          scheduleRealtimeRefresh();
          return;
        }
      }
    } catch (_) {}
  }

  function scheduleRealtimeRefresh() {
    if (realtimeRefreshTimer) clearTimeout(realtimeRefreshTimer);
    realtimeRefreshTimer = setTimeout(() => {
      loadData(true);
    }, REALTIME_REFRESH_DEBOUNCE_MS);
  }

  function connectRpcWs() {
    if (!allowRpcReconnect) return;

    try {
      rpcWs = new WebSocket(RPC_WS_URL);
      rpcWs.onopen = () => {
        rpcReconnectAttempt = 0;
        rpcWs.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'subscribe',
          id: 1,
          params: { query: "tm.event='NewBlock'" }
        }));
      };
      rpcWs.onmessage = (event) => {
        try {
          checkBlockForMarketRefresh(JSON.parse(event.data));
        } catch (_) {}
      };
      rpcWs.onclose = () => {
        rpcWs = null;
        reconnectRpcWs();
      };
      rpcWs.onerror = () => {};
    } catch (_) {
      reconnectRpcWs();
    }
  }

  function reconnectRpcWs() {
    if (!allowRpcReconnect) return;

    const delay = Math.min(RPC_RECONNECT_BASE_MS * (2 ** rpcReconnectAttempt), RPC_RECONNECT_MAX_MS);
    rpcReconnectAttempt += 1;

    if (rpcReconnectTimer) clearTimeout(rpcReconnectTimer);
    rpcReconnectTimer = setTimeout(connectRpcWs, delay);
  }

  function disconnectRpcWs() {
    if (rpcWs) {
      rpcWs.onclose = null;
      rpcWs.close();
      rpcWs = null;
    }
  }

  function isConnectedWalletOrder(order) {
    const sender = normalizeAddress(order?.sender ?? '');
    return !!sender && connectedWalletAddresses.includes(sender);
  }

  // Helpers
  function formatUSD(value) {
    if (!value && value !== 0) return '$0';
    const num = typeof value === 'string' ? parseFloat(value) : value;
    const decimals = Math.abs(num) < 1 ? 2 : 0;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(num);
  }

  function formatAmount(amount, maxDecimals = 6) {
    if (!amount && amount !== 0) return '0';
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (num >= 1000) return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (num >= 1) return num.toLocaleString('en-US', { maximumFractionDigits: 4 });
    return num.toLocaleString('en-US', { maximumFractionDigits: maxDecimals });
  }

  function formatRatio(ratio) {
    if (!ratio) return 'N/A';
    if (ratio >= 1000) return ratio.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (ratio >= 1) return ratio.toLocaleString('en-US', { maximumFractionDigits: 4 });
    if (ratio >= 0.001) return ratio.toLocaleString('en-US', { maximumFractionDigits: 6 });
    return ratio.toExponential(4);
  }

  function formatRateInput(value) {
    if (!value || !Number.isFinite(value)) return '';
    return value.toPrecision(6).replace(/\.?0+$/, '');
  }

  function formatHistoryValueUsd(value) {
    if (value == null || !Number.isFinite(Number(value))) return 'N/A';

    const num = typeof value === 'string' ? parseFloat(value) : value;
    const abs = Math.abs(num);

    if (abs === 0) return '$0';

    if (abs >= 1000) {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
      }).format(num);
    }

    if (abs >= 1) {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(num);
    }

    if (abs >= 0.01) {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 4
      }).format(num);
    }

    return '<$0.01';
  }

  function formatHistoryAmount(row) {
    if (!row) return '0';
    const amount = formatAmount(row.displayAmount);
    return row.displayAmountSymbol ? `${amount} ${row.displayAmountSymbol}` : amount;
  }

  function getTradeHistoryNote(pair) {
    if (!pair) return 'THORChain pool ratio is the source of truth for this market.';
    return 'THORChain pool ratio is the source of truth. Direct pair swaps show execution price; routed pool movers show TC market price at the event time.';
  }

  function shortenAddress(addr) {
    if (!addr) return '';
    if (addr.length <= 14) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  function timeSince(date) {
    if (!date) return '';
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  }

  function shortAsset(asset) {
    if (!asset) return '';
    const normalized = normalizeAsset(asset);
    // Strip chain prefix for display: "BTC.BTC" -> "BTC"
    const parts = normalized.split('.');
    return parts.length > 1 ? parts[1] : parts[0];
  }

  function formatThorAsset(asset) {
    return normalizeAsset(asset);
  }

  function formatThorAssetLabel(asset) {
    return formatThorAsset(asset);
  }

  function formatQuotedPairPrice(value, quoteAsset) {
    return formatRatio(value);
  }

  const assetIconMap = {
    AAVE: '/assets/coins/aave-aave-logo.svg',
    ATOM: '/assets/coins/cosmos-atom-logo.svg',
    AVAX: '/assets/coins/avalanche-avax-logo.svg',
    BCH: '/assets/coins/bitcoin-cash-bch-logo.svg',
    BNB: '/assets/coins/binance-coin-bnb-logo.svg',
    BTC: '/assets/coins/bitcoin-btc-logo.svg',
    BUSD: '/assets/coins/binance-usd-busd-logo.svg',
    DAI: '/assets/coins/multi-collateral-dai-dai-logo.svg',
    DOGE: '/assets/coins/dogecoin-doge-logo.svg',
    ETH: '/assets/coins/ethereum-eth-logo.svg',
    FOX: '/assets/coins/fox-token-fox-logo.svg',
    GUSD: '/assets/coins/gemini-dollar-gusd-logo.svg',
    LINK: '/assets/coins/chainlink-link-logo.svg',
    LTC: '/assets/coins/litecoin-ltc-logo.svg',
    LUSD: '/assets/coins/liquity-usd-logo.svg',
    RUNE: '/assets/coins/thorchain-rune-logo.svg',
    SOL: '/assets/coins/solana-sol-logo.svg',
    SNX: '/assets/coins/synthetix-snx-logo.svg',
    TCY: '/assets/coins/TCY.svg',
    TRX: '/assets/coins/TRON.svg',
    TWT: '/assets/coins/twt-logo.png',
    USDC: '/assets/coins/usd-coin-usdc-logo.svg',
    USDP: '/assets/coins/paxos-standard-usdp-logo.svg',
    USDT: '/assets/coins/tether-usdt-logo.svg',
    VTHOR: '/assets/coins/VTHOR.svg',
    WBTC: '/assets/coins/wrapped-bitcoin-wbtc-logo.svg',
    YFI: '/assets/coins/YFI.svg'
  };

  const chainIconMap = {
    AVAX: '/assets/chains/AVAX.svg',
    BASE: '/assets/chains/BASE.svg',
    BCH: '/assets/chains/BCH.svg',
    BSC: '/assets/chains/BSC.svg',
    BTC: '/assets/chains/BTC.svg',
    DOGE: '/assets/chains/DOGE.svg',
    ETH: '/assets/chains/ETH.svg',
    GAIA: '/assets/chains/GAIA.svg',
    LTC: '/assets/chains/LTC.svg',
    SOL: '/assets/chains/SOL.svg',
    THOR: '/assets/chains/THOR.svg',
    TRON: '/assets/chains/TRON.svg'
  };

  function getAssetIcon(asset) {
    const symbol = shortAsset(asset).toUpperCase();
    if (assetIconMap[symbol]) return assetIconMap[symbol];

    const chain = getChainFromAsset(asset).toUpperCase();
    if (chainIconMap[chain]) return chainIconMap[chain];

    return '/assets/coins/fallback-logo.svg';
  }

  const THOR_BASE = 100000000n;
  const AFFILIATE_NAME = 'bt';
  const AFFILIATE_BPS = '10';

  function toAtomicAmount(value) {
    const normalized = String(value ?? '').trim();
    if (!normalized || !/^\d*\.?\d+$/.test(normalized)) return null;

    const [whole = '0', fraction = ''] = normalized.split('.');
    const paddedFraction = (fraction + '00000000').slice(0, 8);
    const atomic = BigInt(`${whole || '0'}${paddedFraction}`);
    return atomic > 0n ? atomic : null;
  }

  function getTradeConfig(pair, side) {
    if (!pair) return null;

    const baseAsset = pair.sourceAsset;
    const quoteAsset = pair.targetAsset;
    const limitBaseAsset = pair.limitSourceAsset ?? baseAsset;
    const limitQuoteAsset = pair.limitTargetAsset ?? quoteAsset;
    const isBuy = side === 'buy';

    return {
      baseAsset,
      quoteAsset,
      limitBaseAsset,
      limitQuoteAsset,
      sellAsset: isBuy ? quoteAsset : baseAsset,
      buyAsset: isBuy ? baseAsset : quoteAsset,
      sellLimitAsset: isBuy ? limitQuoteAsset : limitBaseAsset,
      buyLimitAsset: isBuy ? limitBaseAsset : limitQuoteAsset,
      baseSymbol: shortAsset(baseAsset),
      quoteSymbol: shortAsset(quoteAsset),
      sellSymbol: shortAsset(isBuy ? quoteAsset : baseAsset),
      buySymbol: shortAsset(isBuy ? baseAsset : quoteAsset)
    };
  }

  function isTradeAssetIdentifier(asset) {
    return String(asset ?? '').includes('~');
  }

  function getSettlementChain(asset) {
    if (!asset) return '';
    return isTradeAssetIdentifier(asset) ? 'THOR' : getChainFromAsset(asset);
  }

  function getSourceChain(trade, mode = orderType) {
    const asset = mode === 'limit' ? trade?.sellLimitAsset : trade?.sellAsset;
    return getSettlementChain(asset);
  }

  function calculateLimitTargetAmount(amountAtomic, priceAtomic, side) {
    if (!amountAtomic || !priceAtomic || priceAtomic <= 0n) return null;
    return side === 'buy'
      ? (amountAtomic * THOR_BASE) / priceAtomic
      : (amountAtomic * priceAtomic) / THOR_BASE;
  }

  function calculateLimitReturn(amount, price, side) {
    const amountValue = parseFloat(amount);
    const priceValue = parseFloat(price);

    if (!Number.isFinite(amountValue) || amountValue <= 0 || !Number.isFinite(priceValue) || priceValue <= 0) {
      return null;
    }

    return side === 'buy' ? amountValue / priceValue : amountValue * priceValue;
  }

  const TTL_PRESETS = [
    { label: '1h', blocks: 600 },
    { label: '6h', blocks: 3600 },
    { label: '1d', blocks: 14400 },
    { label: '3d', blocks: 43200 }
  ];
  let selectedTTL = 14400; // default 1d

  function getAffiliateParams() {
    return {
      affiliate: AFFILIATE_NAME,
      affiliate_bps: AFFILIATE_BPS
    };
  }

  function getDestinationChain(trade, mode = orderType) {
    const asset = mode === 'limit' ? trade?.buyLimitAsset : trade?.buyAsset;
    return getSettlementChain(asset);
  }

  function getSourceAssignment(trade, mode = orderType) {
    const sourceChain = getSourceChain(trade, mode);
    return sourceChain ? getAssignedAccount($walletAccounts, $chainAssignments, sourceChain) : null;
  }

  function getDestinationAssignment(trade, mode = orderType) {
    const destinationChain = getDestinationChain(trade, mode);
    return destinationChain ? getAssignedAccount($walletAccounts, $chainAssignments, destinationChain) : null;
  }

  function getTradeOwnerSelection() {
    return getTradeOwnerAccount($walletAccounts, $tradeOwner);
  }

  function getSourceAddress(trade, mode = orderType) {
    return getSourceAssignment(trade, mode)?.address || '';
  }

  function getAutoDestinationAddress(trade, mode = orderType) {
    if (!trade) return '';

    const destinationAsset = mode === 'limit' ? trade?.buyLimitAsset : trade?.buyAsset;
    if (isTradeAssetIdentifier(destinationAsset)) {
      return getTradeOwnerSelection()?.address || '';
    }

    return getDestinationAssignment(trade, mode)?.address || '';
  }

  function getResolvedDestinationAddress(trade, mode = orderType) {
    const manualAddress = destinationAddress.trim();
    return manualAddress || getAutoDestinationAddress(trade, mode);
  }

  function getDestinationError(trade, mode = orderType) {
    const destinationChain = getDestinationChain(trade, mode);
    const destinationAsset = mode === 'limit' ? trade?.buyLimitAsset : trade?.buyAsset;

    if (isTradeAssetIdentifier(destinationAsset)) {
      return 'Assign a THOR trade owner or enter a THOR destination address';
    }

    return destinationChain
      ? `Enter a ${destinationChain} destination address`
      : 'Enter a destination address';
  }

  function getSourceError(trade, mode = orderType) {
    const sourceChain = getSourceChain(trade, mode);
    return sourceChain
      ? `Assign a ${sourceChain} source wallet`
      : 'Connect the source wallet required for this order';
  }

  function getSubmitAssignmentIssue(trade, mode = orderType) {
    if (!trade) return '';

    if (!getSourceAssignment(trade, mode)?.provider) {
      return getSourceError(trade, mode);
    }

    const destinationAsset = mode === 'limit' ? trade?.buyLimitAsset : trade?.buyAsset;
    if (isTradeAssetIdentifier(destinationAsset) && !getTradeOwnerSelection()?.address && !destinationAddress.trim()) {
      return 'Assign a THOR trade owner or enter a THOR destination address';
    }

    return '';
  }

  // ============================================
  // Order Placement (connected wallet)
  // ============================================

  async function handlePlaceOrder() {
    if (!selectedPair || !placeOrderPrice || !placeOrderAmount) return;
    if (!$isWalletConnected) { showWalletModal = true; return; }

    placingOrder = true;
    placeOrderError = '';
    placeOrderSuccess = '';
    try {
      const trade = getTradeConfig(selectedPair, orderSide);
      const sellAmountAtomic = toAtomicAmount(placeOrderAmount);
      const priceAtomic = toAtomicAmount(placeOrderPrice);
      const targetAmountAtomic = calculateLimitTargetAmount(sellAmountAtomic, priceAtomic, orderSide);

      if (!trade || !sellAmountAtomic || !targetAmountAtomic) {
        throw new Error('Enter a valid amount and price');
      }

      const destination = getResolvedDestinationAddress(trade, 'limit');
      if (!destination) throw new Error(getDestinationError(trade, 'limit'));
      const sourceAssignment = getSourceAssignment(trade, 'limit');
      const sourceAddress = sourceAssignment?.address || '';
      if (!sourceAddress || !sourceAssignment?.provider) throw new Error(getSourceError(trade, 'limit'));

      const params = {
        from_asset: trade.sellLimitAsset,
        to_asset: trade.buyLimitAsset,
        amount: sellAmountAtomic.toString(),
        destination,
        target_out: targetAmountAtomic.toString(),
        custom_ttl: String(selectedTTL),
        ...getAffiliateParams()
      };

      const quote = await fetchLimitQuote(params);
      if (!quote || !quote.memo) throw new Error('Failed to get quote');

      const { broadcastSwap } = await getWalletModule();
      const txHash = await broadcastSwap({
        buyAsset: trade.buyLimitAsset,
        destinationAddress: destination,
        quote,
        sellAmount: sellAmountAtomic.toString(),
        sellAsset: trade.sellLimitAsset,
        sourceAddress
      }, { provider: sourceAssignment.provider });
      placeOrderSuccess = `${orderSide === 'buy' ? 'Buy' : 'Sell'} order submitted! TX: ${txHash}`;
      placeOrderPrice = '';
      placeOrderAmount = '';

      // Refresh orderbook
      setTimeout(() => refreshSelectedPairData(true), 6000);
    } catch (err) {
      placeOrderError = err.message || 'Failed to place order';
    }
    placingOrder = false;
  }

  // ============================================
  // Market Order
  // ============================================

  function debouncedFetchMarketQuote() {
    if (marketQuoteTimer) clearTimeout(marketQuoteTimer);
    marketQuoteTimer = setTimeout(fetchMarketQuote, 500);
  }

  async function fetchMarketQuote() {
    if (!selectedPair || !placeOrderAmount || orderType !== 'market') return;
    const trade = getTradeConfig(selectedPair, orderSide);
    const sellAmountAtomic = toAtomicAmount(placeOrderAmount);
    if (!trade || !sellAmountAtomic) { marketQuote = null; return; }

    const destination = getResolvedDestinationAddress(trade, 'market');
    if (!destination) {
      marketQuote = null;
      marketQuoteError = getDestinationError(trade, 'market');
      return;
    }

    marketQuoteLoading = true;
    marketQuoteError = '';
    try {
      const params = {
        from_asset: trade.sellAsset,
        to_asset: trade.buyAsset,
        amount: sellAmountAtomic.toString(),
        streaming_interval: '1',
        streaming_quantity: '0',
        destination,
        ...getAffiliateParams()
      };
      if (marketSlippage > 0) params.tolerance_bps = String(marketSlippage);

      marketQuote = await thornode.getSwapQuote(params);
    } catch (err) {
      marketQuoteError = err.message || 'Quote failed';
      marketQuote = null;
    }
    marketQuoteLoading = false;
  }

  async function handlePlaceMarketOrder() {
    if (!selectedPair || !placeOrderAmount || !marketQuote) return;
    if (!$isWalletConnected) { showWalletModal = true; return; }

    placingOrder = true;
    placeOrderError = '';
    placeOrderSuccess = '';
    try {
      const trade = getTradeConfig(selectedPair, orderSide);
      const sellAmountAtomic = toAtomicAmount(placeOrderAmount);
      if (!trade || !sellAmountAtomic) {
        throw new Error('Enter a valid amount');
      }

      const destination = getResolvedDestinationAddress(trade, 'market');
      if (!destination) throw new Error(getDestinationError(trade, 'market'));
      const sourceAssignment = getSourceAssignment(trade, 'market');
      const sourceAddress = sourceAssignment?.address || '';
      if (!sourceAddress || !sourceAssignment?.provider) throw new Error(getSourceError(trade, 'market'));

      const params = {
        from_asset: trade.sellAsset,
        to_asset: trade.buyAsset,
        amount: sellAmountAtomic.toString(),
        streaming_interval: '1',
        streaming_quantity: '0',
        destination,
        ...getAffiliateParams()
      };
      if (marketSlippage > 0) params.tolerance_bps = String(marketSlippage);

      const quote = await thornode.getSwapQuote(params);
      if (!quote?.memo) throw new Error('Failed to get swap quote');

      const { broadcastSwap } = await getWalletModule();
      const txHash = await broadcastSwap({
        buyAsset: trade.buyAsset,
        destinationAddress: destination,
        quote,
        sellAmount: sellAmountAtomic.toString(),
        sellAsset: trade.sellAsset,
        sourceAddress
      }, { provider: sourceAssignment.provider });
      placeOrderSuccess = `${orderSide === 'buy' ? 'Buy' : 'Sell'} order submitted! TX: ${txHash}`;
      placeOrderAmount = '';
      marketQuote = null;
    } catch (err) {
      placeOrderError = err.message || 'Swap failed';
    }
    placingOrder = false;
  }

  // Auto-fetch market quote when trade inputs change
  $: {
    const marketQuoteDestination = resolvedDestinationAddress;
    const walletKey = connectedWalletAddresses.join('|');

    if (
      orderType === 'market' &&
      placeOrderAmount &&
      selectedPair &&
      orderSide &&
      marketSlippage >= 0
    ) {
      marketQuoteDestination;
      walletKey;
      debouncedFetchMarketQuote();
    } else if (orderType !== 'market' || !placeOrderAmount || !selectedPair) {
      if (marketQuoteTimer) clearTimeout(marketQuoteTimer);
      marketQuote = null;
      marketQuoteError = '';
    }
  }

  // ============================================
  // Cancel Order
  // ============================================

  async function handleCancelOrder(order) {
    if (!$isWalletConnected) { showWalletModal = true; return; }

    const ownerAccount = getTradeOwnerSelection();
    if (!ownerAccount?.provider) {
      showWalletModal = true;
      showToast('Assign a THOR trade owner to cancel orders');
      return;
    }

    cancellingTxId = order.txId;
    try {
      const memo = createCancelMemo(
        order.sourceAmountRaw,
        order.sourceAsset,
        order.targetAmountRaw,
        order.targetAsset
      );

      const { broadcastDeposit } = await getWalletModule();
      const txHash = await broadcastDeposit({
        amount: '0',
        asset: order.sourceAsset,
        memo
      }, { provider: ownerAccount.provider });
      showToast(`Cancel submitted! TX: ${txHash?.slice(0, 12)}...`);

      // Refresh after block time
      setTimeout(() => refreshSelectedPairData(true), 6000);
    } catch (err) {
      const message = err.message || 'Cancel failed';
      showToast(`Cancel failed: ${message}`);
    }
    cancellingTxId = null;
  }

  // ============================================
  // Memoless Flow
  // ============================================

  async function handleMemolessOrder() {
    if (!selectedPair || !placeOrderPrice || !placeOrderAmount) return;

    creatingMemoless = true;
    memolessError = '';
    memolessChannel = null;
    try {
      const trade = getTradeConfig(selectedPair, orderSide);
      const sellAmountAtomic = toAtomicAmount(placeOrderAmount);
      const priceAtomic = toAtomicAmount(placeOrderPrice);
      const targetAmountAtomic = calculateLimitTargetAmount(sellAmountAtomic, priceAtomic, orderSide);

      if (!trade || !sellAmountAtomic || !targetAmountAtomic) {
        throw new Error('Enter a valid amount and price');
      }

      const destination = getResolvedDestinationAddress(trade, 'limit');
      if (!destination) throw new Error(getDestinationError(trade, 'limit'));

      const params = {
        from_asset: trade.sellLimitAsset,
        to_asset: trade.buyLimitAsset,
        amount: sellAmountAtomic.toString(),
        destination,
        target_out: targetAmountAtomic.toString(),
        custom_ttl: String(selectedTTL),
        ...getAffiliateParams()
      };
      const quote = await fetchLimitQuote(params);
      if (!quote?.memo) throw new Error('Failed to get quote');

      const { createMemolessChannel } = await getWalletModule();
      memolessChannel = await createMemolessChannel(
        trade.sellAsset,
        quote.memo,
        placeOrderAmount
      );
    } catch (err) {
      memolessError = err.message || 'Memoless registration failed';
    }
    creatingMemoless = false;
  }

  // Check for memoless assets on mount
  async function loadMemolessAssets() {
    try {
      const { getMemolessAssets } = await getWalletModule();
      memolessAssets = await getMemolessAssets();
    } catch (e) { /* ignore */ }
  }

  $: isMemolessAvailable = tradeConfig && memolessAssets.some(
    a => (
      tradeConfig.sellAsset === tradeConfig.sellLimitAsset &&
      (a.asset === tradeConfig.sellAsset || normalizeAsset(a.asset) === normalizeAsset(tradeConfig.sellAsset))
    )
  );

  // Filtered pairs for search
  $: filteredPairs = pairList.filter(pair => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return pair.searchText.includes(term);
  });

  $: normalizedWalletOrders = walletPairOrders
    .map((order) => normalizeLimitSwap(order, priceIndex))
    .filter(Boolean);

  $: openOrders = selectedPair
    ? normalizedWalletOrders
      .map((order) => ({
        ...order,
        displaySide: getOrderSideForPair(order, selectedPair.sourceAsset, selectedPair.targetAsset),
        displayPrice: getOrderDisplayPrice(order, selectedPair.sourceAsset, selectedPair.targetAsset),
        displayAmount: getOrderDisplayAmount(order, selectedPair.sourceAsset, selectedPair.targetAsset)
      }))
      .filter((order) => order.displaySide && order.displayPrice != null && order.displayAmount != null)
    : [];

  $: historyOrders = selectedPair
    ? walletTradeActions
      .map((action) => normalizeTradeActionForPair(action, selectedPair.sourceAsset, selectedPair.targetAsset))
      .filter(Boolean)
      .sort((left, right) => Number(right?.date || 0) - Number(left?.date || 0))
    : [];

  $: filledOrders = historyOrders.filter((order) => order.isLimitOrder);
  $: visibleOrders = myOrdersTab === 'open'
    ? openOrders
    : myOrdersTab === 'filled'
      ? filledOrders
      : historyOrders;

  // Filtered book levels based on bookFilter
  $: filteredAsks = (orderBook && (bookFilter === 'all' || bookFilter === 'sell'))
    ? orderBook.asks
    : [];
  $: filteredBids = (orderBook && (bookFilter === 'all' || bookFilter === 'buy'))
    ? orderBook.bids
    : [];

  // ============================================
  // Trading Terminal UI State
  // ============================================
  let orderSide = 'buy'; // 'buy' | 'sell'
  let amountSlider = 0;
  let myOrdersTab = 'open'; // 'open' | 'filled' | 'history'
  let mobilePanel = 'chart'; // 'chart' | 'book' | 'orders' | 'form'
  let showPairsDrawer = false;
  let tradeConfig = null;
  let limitEstimatedReturn = null;
  let walletActivityKey = '';

  $: connectedWalletAddresses = Array.from(new Set(
    ($walletAccounts || [])
      .map((account) => normalizeAddress(account?.address ?? ''))
      .filter(Boolean)
  ));

  $: tradeConfig = getTradeConfig(selectedPair, orderSide);

  // Auto-fill target rate with market price when pair changes
  let lastAutoRatePair = '';
  $: {
    const pairKey = selectedPair ? `${selectedPair.sourceAsset}|${selectedPair.targetAsset}` : '';
    if (pairKey && pairKey !== lastAutoRatePair && marketRatio && !placeOrderPrice) {
      placeOrderPrice = formatRateInput(marketRatio);
      lastAutoRatePair = pairKey;
    } else if (pairKey !== lastAutoRatePair) {
      lastAutoRatePair = pairKey;
    }
  }

  $: limitEstimatedReturn = calculateLimitReturn(placeOrderAmount, placeOrderPrice, orderSide);
  $: destinationChain = getDestinationChain(tradeConfig, orderType);
  $: resolvedDestinationAddress = getResolvedDestinationAddress(tradeConfig, orderType);

  $: {
    const nextAutoDestination = getAutoDestinationAddress(tradeConfig, orderType);
    const chainChanged = destinationChain !== lastDestinationChain;
    const shouldReplaceDestination =
      chainChanged ||
      !destinationAddress ||
      destinationAddress === lastAutoDestinationAddress;

    if (shouldReplaceDestination) {
      destinationAddress = nextAutoDestination;
    }

    lastAutoDestinationAddress = nextAutoDestination;
    lastDestinationChain = destinationChain;
  }

  $: {
    const nextWalletActivityKey = selectedPair
      ? `${selectedPair.sourceAsset}|${selectedPair.targetAsset}|${connectedWalletAddresses.join('|')}`
      : '';

    if (nextWalletActivityKey !== walletActivityKey) {
      walletActivityKey = nextWalletActivityKey;

      if (selectedPair) {
        loadWalletActivity(selectedPair, true);
      } else {
        walletPairOrders = [];
        walletTradeActions = [];
      }
    }
  }

  // Market ratio for header
  $: marketRatio = selectedPair?.marketPrice ?? null;
  $: marketRatioUSD = selectedPair?.sourcePriceUsd || 0;

  // 24h stats for header
  let pairStats24h = null;
  async function load24hStats(pair) {
    if (!pair?.sourceAsset || !pair?.targetAsset) { pairStats24h = null; return; }
    try {
      const series = await thorchainChartDataProvider.getPairSeries(pair, '24H');
      if (!series?.candles?.length) { pairStats24h = null; return; }
      const candles = series.candles;
      const first = candles[0];
      const last = candles[candles.length - 1];
      const high = Math.max(...candles.map(c => c.high));
      const low = Math.min(...candles.map(c => c.low));
      const change = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0;
      pairStats24h = { high, low, change, lastPrice: last.close };
    } catch { pairStats24h = null; }
  }
  $: if (selectedPair) load24hStats(selectedPair);
  $: orderBookCenterPrice = orderBook?.midPrice ?? marketRatio ?? null;
  $: summaryTotalOrders = Number(summary?.total_limit_swaps ?? 0);
  $: summaryTotalValueUsd = fromBaseUnit(summary?.total_value_usd ?? 0);
  $: connectedWalletCount = ($walletAccounts || []).length;
  $: selectedTradeOwnerAccount = getTradeOwnerSelection();
  $: submitAssignmentIssue = tradeConfig ? getSubmitAssignmentIssue(tradeConfig, orderType) : '';

  // Slider reactive update
  $: if (amountSlider > 0 && selectedPair && placeOrderPrice) {
    // Placeholder: slider would control amount based on balance
  }
</script>

<!-- ===================== TRADING TERMINAL LAYOUT ===================== -->
<div class="trade" class:trade--no-pair={!selectedPair}>

  <!-- ===== HEADER ===== -->
  <div class="trade__header">
    <!-- Pair Selector (THORDex-style: two asset buttons with arrow) -->
    <button class="header__asset-btn" on:click={() => showPairsDrawer = true}>
      {#if selectedPair}
        <img class="header__asset-icon" src={getAssetIcon(selectedPair.sourceAsset)} alt="" />
        <div class="header__asset-info">
          <span class="header__asset-ticker">{shortAsset(selectedPair.sourceAsset)}</span>
          <span class="header__asset-chain">{getChainFromAsset(selectedPair.sourceAsset)}</span>
        </div>
      {:else}
        <span class="header__asset-ticker">Select</span>
      {/if}
      <svg class="header__asset-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </button>

    <span class="header__arrow">&#8594;</span>

    <button class="header__asset-btn" on:click={() => showPairsDrawer = true}>
      {#if selectedPair}
        <img class="header__asset-icon" src={getAssetIcon(selectedPair.targetAsset)} alt="" />
        <div class="header__asset-info">
          <span class="header__asset-ticker">{shortAsset(selectedPair.targetAsset)}</span>
          <span class="header__asset-chain">{getChainFromAsset(selectedPair.targetAsset)}</span>
        </div>
      {:else}
        <span class="header__asset-ticker">Pair</span>
      {/if}
      <svg class="header__asset-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </button>

    <!-- 24h Stats -->
    <div class="header__stats">
      {#if selectedPair}
        <div class="header__stat">
          <span class="header__stat-label">Price</span>
          <span class="header__stat-val">{marketRatio ? formatRatio(marketRatio) : '-'}</span>
        </div>
        <div class="header__stat">
          <span class="header__stat-label">24h Change</span>
          {#if pairStats24h}
            <span class="header__stat-val" class:header__stat-val--positive={pairStats24h.change > 0} class:header__stat-val--negative={pairStats24h.change < 0}>
              {pairStats24h.change > 0 ? '+' : ''}{pairStats24h.change.toFixed(2)}%
            </span>
          {:else}
            <span class="header__stat-val">-</span>
          {/if}
        </div>
        <div class="header__stat">
          <span class="header__stat-label">24h High</span>
          <span class="header__stat-val">{pairStats24h ? formatRatio(pairStats24h.high) : '-'}</span>
        </div>
        <div class="header__stat">
          <span class="header__stat-label">24h Low</span>
          <span class="header__stat-val">{pairStats24h ? formatRatio(pairStats24h.low) : '-'}</span>
        </div>
      {:else if summary}
        <div class="header__stat">
          <span class="header__stat-label">Total Orders</span>
          <span class="header__stat-val header__stat-val--accent">{summaryTotalOrders.toLocaleString()}</span>
        </div>
        <div class="header__stat">
          <span class="header__stat-label">Pairs</span>
          <span class="header__stat-val">{pairList.length.toLocaleString()}</span>
        </div>
      {/if}
    </div>

    <div class="header__right">
      <button class="header__refresh" on:click={() => loadData(false)} title="Refresh">
        <svg class:spinning={loading} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"></polyline>
          <polyline points="1 20 1 14 7 14"></polyline>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
      </button>
      <button class="header__wallet" class:connected={$isWalletConnected} on:click={() => showWalletModal = true}>
        {#if $isWalletConnected}
          {#if selectedTradeOwnerAccount?.address}
            {selectedTradeOwnerAccount.address.slice(0, 6)}...{selectedTradeOwnerAccount.address.slice(-4)}
          {:else}
            Connected ({connectedWalletCount})
          {/if}
        {:else}
          Connect Wallet
        {/if}
      </button>
    </div>
  </div>

  <!-- ===== MOBILE TAB NAV ===== -->
  <div class="mobile-tabs">
    <button class="mobile-tab" class:active={mobilePanel === 'chart'} on:click={() => mobilePanel = 'chart'}>Chart</button>
    <button class="mobile-tab" class:active={mobilePanel === 'book'} on:click={() => mobilePanel = 'book'}>Book</button>
    <button class="mobile-tab" class:active={mobilePanel === 'form'} on:click={() => mobilePanel = 'form'}>Trade</button>
    <button class="mobile-tab" class:active={mobilePanel === 'orders'} on:click={() => mobilePanel = 'orders'}>Orders</button>
  </div>

  <!-- ===== LOADING OVERLAY ===== -->
  {#if loading && !summary}
    <div class="trade__loading">
      <div class="spinner"></div>
      <span>Loading limit orders...</span>
    </div>
  {:else if error && !summary}
    <div class="trade__loading">
      <span class="trade__error-text">{error}</span>
      <button class="trade__retry" on:click={() => loadData(false)}>Retry</button>
    </div>
  {:else}

    <!-- ===== CHART (Left, Row 2) ===== -->
      <div class="trade__graph" class:mobile-hidden={mobilePanel !== 'chart'}>
      <ThorchainPairChart pair={selectedPair} marketPrice={marketRatio} refreshKey={lastUpdated ? lastUpdated.getTime() : 0} />
      </div>

    <!-- ===== PAIRS DRAWER (overlay) ===== -->
    {#if showPairsDrawer}
      <div
        class="pairs-drawer-backdrop"
        role="button"
        tabindex="0"
        aria-label="Close market selector"
        on:click={() => showPairsDrawer = false}
        on:keydown={(event) => handleKeyActivate(event, () => showPairsDrawer = false)}
        transition:fade={{ duration: 100 }}
      >
        <div
          class="pairs-drawer"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          on:click|stopPropagation
          on:keydown|stopPropagation={() => {}}
          transition:fly={{ x: -300, duration: 200 }}
        >
          <div class="pairs-drawer__head">
            <span class="pairs-drawer__title">Markets</span>
            <button class="pairs-drawer__close" aria-label="Close market selector" on:click={() => showPairsDrawer = false}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
          <div class="pairs-drawer__search">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#484f58" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            <input type="text" placeholder="Search pairs..." bind:value={searchTerm} />
          </div>
          <div class="pairs-drawer__list">
            {#each filteredPairs as pair}
              <button
                class="pairs-drawer__row"
                class:active={selectedPair && pair.sourceAsset === selectedPair.sourceAsset && pair.targetAsset === selectedPair.targetAsset}
                on:click={() => { selectPair(pair); showPairsDrawer = false; }}
              >
                <span class="pairs-drawer__name">
                  <img class="asset-icon asset-icon--inline" src={getAssetIcon(pair.sourceAsset)} alt={shortAsset(pair.sourceAsset)} />
                  {formatThorAssetLabel(pair.sourceAsset)}
                  <span class="pairs-drawer__separator">/</span>
                  <img class="asset-icon asset-icon--inline" src={getAssetIcon(pair.targetAsset)} alt={shortAsset(pair.targetAsset)} />
                  {formatThorAssetLabel(pair.targetAsset)}
                </span>
                <span class="pairs-drawer__orders">{pair.count.toLocaleString()}</span>
                <span class="pairs-drawer__value">
                  <img class="asset-icon asset-icon--price" src={getAssetIcon(pair.targetAsset)} alt={shortAsset(pair.targetAsset)} />
                  {formatQuotedPairPrice(pair.marketPrice, pair.targetAsset)}
                </span>
              </button>
            {/each}
          </div>
        </div>
      </div>
    {/if}

    <!-- ===== ORDERBOOK (Center, Row 2) ===== -->
    <div class="trade__book" class:mobile-hidden={mobilePanel !== 'book'}>
      <div class="panel">
        <div class="panel__head">
          <span class="panel__title">ORDER BOOK</span>
          <div class="book-filters">
            <button class="book-filter" class:active={bookFilter === 'all'} on:click={() => bookFilter = 'all'} title="All orders">
              <svg width="12" height="12" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="6" fill="#cc3333" opacity="0.7"/><rect x="1" y="9" width="14" height="6" fill="#00cc66" opacity="0.7"/></svg>
            </button>
            <button class="book-filter" class:active={bookFilter === 'buy'} on:click={() => bookFilter = 'buy'} title="Bids only">
              <svg width="12" height="12" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" fill="#00cc66" opacity="0.7"/></svg>
            </button>
            <button class="book-filter" class:active={bookFilter === 'sell'} on:click={() => bookFilter = 'sell'} title="Asks only">
              <svg width="12" height="12" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" fill="#cc3333" opacity="0.7"/></svg>
            </button>
          </div>
        </div>

        <!-- Column Headers -->
        <div class="book__cols">
          <span>Price</span>
          <span>Amount</span>
          <span>Value</span>
        </div>

        {#if !selectedPair}
          <div class="book__empty">Select a trading pair</div>
        {:else if loadingPairDetails}
          <div class="book__empty"><div class="spinner small"></div></div>
        {:else}
          <!-- Asks (sells) - column-reverse so lowest ask is near spread -->
          <div class="book__asks">
            {#if filteredAsks.length === 0}
              <div class="book__side-empty">No sell orders</div>
            {:else}
              {#each filteredAsks as level}
                <div
                  class="book__row book__row--sell"
                  role="button"
                  tabindex="0"
                  on:click={() => { placeOrderPrice = String(level.price); }}
                  on:keydown={(event) => handleKeyActivate(event, () => { placeOrderPrice = String(level.price); })}
                >
                  <i style="width: {orderBook.maxDepth > 0 ? (level.cumulative / orderBook.maxDepth * 100) : 0}%"></i>
                  <span class="book__price">{formatRatio(level.price)}</span>
                  <span class="book__amount">{formatAmount(level.totalAmount / 1e8)}</span>
                  <span class="book__value">{formatUSD(level.totalValue)}</span>
                </div>
              {/each}
            {/if}
          </div>

          <!-- Spread -->
          <div class="book__spread">
            {#if orderBookCenterPrice != null}
              <span class="book__spread-price">{formatRatio(orderBookCenterPrice)}</span>
              <span class="book__spread-usd">{formatUSD(marketRatioUSD)}</span>
            {:else}
              <span class="book__spread-price">--</span>
            {/if}
            {#if orderBook?.spread != null}
              <span class="book__spread-pct">{orderBook.spread.toFixed(2)}%</span>
            {/if}
          </div>

          <!-- Bids (buys) - highest bid at top -->
          <div class="book__bids">
            {#if filteredBids.length === 0}
              <div class="book__side-empty">No buy orders</div>
            {:else}
              {#each filteredBids as level}
                <div
                  class="book__row book__row--buy"
                  role="button"
                  tabindex="0"
                  on:click={() => { placeOrderPrice = String(level.price); }}
                  on:keydown={(event) => handleKeyActivate(event, () => { placeOrderPrice = String(level.price); })}
                >
                  <i style="width: {orderBook.maxDepth > 0 ? (level.cumulative / orderBook.maxDepth * 100) : 0}%"></i>
                  <span class="book__price">{formatRatio(level.price)}</span>
                  <span class="book__amount">{formatAmount(level.totalAmount / 1e8)}</span>
                  <span class="book__value">{formatUSD(level.totalValue)}</span>
                </div>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <!-- ===== ORDER FORM (Right Column — THORDex-style) ===== -->
    <div class="trade__submit" class:mobile-hidden={mobilePanel !== 'form'}>
      <div class="submit-panel">
        <!-- Limit / Market tabs -->
        <div class="submit__tabs">
          <button class="submit__tab" class:active={orderType === 'limit'} on:click={() => orderType = 'limit'}>Limit</button>
          <button class="submit__tab" class:active={orderType === 'market'} on:click={() => orderType = 'market'}>Market</button>
        </div>

        {#if selectedPair}
          <div class="submit__scroll">
            <!-- You sell -->
            <div class="submit__bloc-label">You sell</div>
            <div class="submit__bloc">
              <div class="submit__bloc-row">
                <input type="text" class="submit__bloc-input" placeholder="0" bind:value={placeOrderAmount} />
                <button class="submit__asset-btn" on:click={() => showPairsDrawer = true}>
                  <img class="submit__asset-icon" src={getAssetIcon(tradeConfig?.sellAsset || selectedPair.sourceAsset)} alt="" />
                  {tradeConfig?.sellSymbol || shortAsset(selectedPair.sourceAsset)} &#9662;
                </button>
              </div>
            </div>
            <div class="submit__pct-row">
              <button class="submit__pct-btn" on:click={() => {}}>25%</button>
              <button class="submit__pct-btn" on:click={() => {}}>50%</button>
              <button class="submit__pct-btn" on:click={() => {}}>75%</button>
              <button class="submit__pct-btn" on:click={() => {}}>MAX</button>
            </div>

            <!-- Swap direction arrow -->
            <div class="submit__swap-arrow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
            </div>

            <!-- You receive -->
            <div class="submit__bloc-label">You receive</div>
            <div class="submit__bloc">
              <div class="submit__bloc-row">
                <input
                  type="text"
                  class="submit__bloc-input"
                  placeholder="0"
                  value={limitEstimatedReturn ? formatAmount(limitEstimatedReturn) : (marketQuote ? formatAmount(fromBaseUnit(marketQuote.expected_amount_out)) : '')}
                  disabled
                />
                <button class="submit__asset-btn" on:click={() => showPairsDrawer = true}>
                  <img class="submit__asset-icon" src={getAssetIcon(tradeConfig?.buyAsset || selectedPair.targetAsset)} alt="" />
                  {tradeConfig?.buySymbol || shortAsset(selectedPair.targetAsset)} &#9662;
                </button>
              </div>
            </div>

            {#if orderType === 'limit'}
              <!-- Target rate -->
              <div class="submit__bloc-label">Target rate</div>
              <div class="submit__bloc">
                <div class="submit__bloc-row">
                  <input type="text" class="submit__bloc-input submit__bloc-input--rate" placeholder="0" bind:value={placeOrderPrice} />
                  <span class="submit__rate-pair">{shortAsset(selectedPair.targetAsset)}/{shortAsset(selectedPair.sourceAsset)}</span>
                </div>
              </div>

              <!-- Time to live -->
              <div class="submit__ttl">
                <div class="submit__ttl-header">
                  <span class="submit__bloc-label">Time to live</span>
                  <span class="submit__ttl-blocks">~{selectedTTL.toLocaleString()} blocks</span>
                </div>
                <div class="submit__ttl-row">
                  {#each TTL_PRESETS as preset}
                    <button
                      class="submit__ttl-btn"
                      class:active={selectedTTL === preset.blocks}
                      on:click={() => selectedTTL = preset.blocks}
                    >{preset.label}</button>
                  {/each}
                </div>
              </div>
            {:else}
              <!-- MARKET: Slippage -->
              <div class="submit__bloc">
                <div class="submit__bloc-label">Slippage Tolerance</div>
                <div class="submit__pct-row">
                  {#each [100, 300, 500] as bps}
                    <button class="submit__pct-btn" class:active={marketSlippage === bps} on:click={() => marketSlippage = bps}>{bps / 100}%</button>
                  {/each}
                  <button class="submit__pct-btn" class:active={marketSlippage === 0} on:click={() => marketSlippage = 0}>None</button>
                </div>
              </div>

              <!-- Quote display -->
              {#if marketQuoteLoading}
                <div class="submit__quote-loading"><div class="spinner tiny"></div> <span>Fetching quote...</span></div>
              {:else if marketQuote}
                <div class="submit__quote-result">
                  {#if marketQuote.fees?.total}
                    <div class="submit__quote-row"><span>Fees</span><span class="submit__quote-val">{formatAmount(fromBaseUnit(marketQuote.fees.total))}</span></div>
                  {/if}
                  {#if marketQuote.slippage_bps != null}
                    <div class="submit__quote-row"><span>Impact</span><span class="submit__quote-val" class:warn={marketQuote.slippage_bps > 300}>{(marketQuote.slippage_bps / 100).toFixed(2)}%</span></div>
                  {/if}
                </div>
              {:else if marketQuoteError}
                <div class="submit__msg submit__msg--error">{marketQuoteError}</div>
              {/if}
            {/if}

            <!-- Recipient -->
            <div class="submit__recipient">
              <div class="submit__bloc-label">Recipient{destinationChain ? ` (${destinationChain})` : ''}</div>
              <input
                type="text"
                class="submit__recipient-input"
                placeholder={destinationChain ? `${destinationChain} address` : 'Destination address'}
                bind:value={destinationAddress}
              />
            </div>
          </div>

          <!-- Error / Success -->
          {#if placeOrderError}
            <div class="submit__msg submit__msg--error">{placeOrderError}</div>
          {/if}
          {#if placeOrderSuccess}
            <div class="submit__msg submit__msg--success">{placeOrderSuccess}</div>
          {/if}

          <!-- Action Button -->
          <div class="submit__footer">
            {#if !$isWalletConnected}
              <button class="submit__action-btn" on:click={() => showWalletModal = true}>Connect Wallet</button>
            {:else if submitAssignmentIssue}
              <div class="submit__msg submit__msg--error">{submitAssignmentIssue}</div>
              <button class="submit__action-btn" on:click={() => showWalletModal = true}>Assign Wallets</button>
            {:else}
              <button
                class="submit__action-btn submit__action-btn--active"
                on:click={orderType === 'market' ? handlePlaceMarketOrder : handlePlaceOrder}
                disabled={placingOrder || !resolvedDestinationAddress || !placeOrderAmount || (orderType === 'limit' && !placeOrderPrice) || (orderType === 'market' && !marketQuote)}
              >
                {#if placingOrder}
                  <div class="spinner tiny"></div> Placing...
                {:else}
                  {orderType === 'market' ? `Swap ${tradeConfig?.sellSymbol || ''} → ${tradeConfig?.buySymbol || ''}` : `Place Limit Order`}
                {/if}
              </button>
            {/if}
          </div>
        {:else}
          <div class="submit__no-pair">Select a trading pair to place an order</div>
        {/if}
      </div>
    </div>

    <!-- ===== ORDERS (Full Width, Row 3 — THORDex-style) ===== -->
    <div class="trade__orders" class:mobile-hidden={mobilePanel !== 'orders'}>
      <div class="orders__tabs">
        <button class="orders__tab" class:active={myOrdersTab === 'open'} on:click={() => myOrdersTab = 'open'}>All Orders</button>
        <button class="orders__tab" class:active={myOrdersTab === 'open'} on:click={() => myOrdersTab = 'open'}>Open Limits</button>
        <button class="orders__tab" class:active={myOrdersTab === 'filled'} on:click={() => myOrdersTab = 'filled'}>Filled Limits</button>
        <button class="orders__tab" class:active={myOrdersTab === 'history'} on:click={() => myOrdersTab = 'history'}>Market Swaps</button>
      </div>

      <div class="orders__body">
        {#if connectedWalletAddresses.length === 0}
          <div class="orders__empty">Connect a wallet to see your order history.</div>
        {:else if !selectedPair}
          <div class="orders__empty">Select a pair to view orders.</div>
        {:else if loadingWalletActivity}
          <div class="orders__empty"><div class="spinner small"></div></div>
        {:else if visibleOrders.length === 0}
          <div class="orders__empty">
            {myOrdersTab === 'open' ? 'No open orders' : myOrdersTab === 'filled' ? 'No filled orders' : 'No market swaps'}
          </div>
        {:else}
          <div class="orders__cols">
            <span>Pair</span>
            <span>Side</span>
            <span>Price</span>
            <span>Amount</span>
            <span>Value</span>
            <span></span>
          </div>
          <div class="orders__list">
            {#each visibleOrders as order}
              <div class="orders__row">
                <span class="orders__cell">
                  <img class="orders__pair-icon" src={getAssetIcon(selectedPair.sourceAsset)} alt="" />
                  <img class="orders__pair-icon orders__pair-icon--overlap" src={getAssetIcon(selectedPair.targetAsset)} alt="" />
                  {shortAsset(selectedPair.sourceAsset)}/{shortAsset(selectedPair.targetAsset)}
                </span>
                <span class="orders__cell">
                  <span class="orders__side-tag" class:orders__side-tag--buy={order.displaySide === 'buy'} class:orders__side-tag--sell={order.displaySide === 'sell'}>
                    {order.displaySide === 'buy' ? 'Buy' : 'Sell'}
                  </span>
                </span>
                <span class="orders__cell orders__cell--mono">{formatRatio(order.displayPrice)}</span>
                <span class="orders__cell orders__cell--mono">{formatAmount(order.displayAmount)}</span>
                <span class="orders__cell orders__cell--mono orders__cell--dim">
                  {order.sourceAmountUSD ? formatUSD(order.sourceAmountUSD) : '-'}
                </span>
                <span class="orders__cell orders__cell--actions">
                  {#if order.txId}
                    <a class="orders__link" href="https://thorchain.net/tx/{order.txId}" target="_blank" rel="noopener noreferrer" title="View TX">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15,3 21,3 21,9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                    </a>
                  {/if}
                  {#if myOrdersTab === 'open' && isConnectedWalletOrder(order)}
                    <button class="orders__cancel" on:click={() => handleCancelOrder(order)} disabled={cancellingTxId === order.txId} title="Cancel">
                      {#if cancellingTxId === order.txId}
                        <div class="spinner tiny"></div>
                      {:else}
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                      {/if}
                    </button>
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>

  {/if}

  <!-- Toast -->
  {#if toastVisible}
    <div class="toast" transition:fly={{ y: 30, duration: 200 }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00cc66" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
      {toastMessage}
    </div>
  {/if}
</div>

<!-- Wallet Connection Modal -->
<ConnectWallet bind:open={showWalletModal} on:connected />

<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap');

  /* =========================================================
     CSS VARIABLES — Bloomberg Terminal Aesthetic
     Matches RapidSwaps / BondTracker / VaultExplorer
     ========================================================= */
  :root {
    --bg-base: #080808;
    --bg-surface: #0a0a0a;
    --bg-elevated: #0d0d0d;
    --bg-row: #0d0d0d;
    --bg-row-hover: #141414;
    --sell: #cc3333;
    --buy: #00cc66;
    --text-primary: #c8c8c8;
    --text-secondary: #aaa;
    --text-muted: #555;
    --text-dim: #444;
    --accent: #00cc66;
    --amber: #d4a017;
    --border: #1a1a1a;
    --border-subtle: #141414;
    --border-input: #222;
    --font-mono: 'JetBrains Mono', monospace;
    --font-sans: 'DM Sans', -apple-system, sans-serif;
  }

  /* =========================================================
     GRID LAYOUT
     ========================================================= */
  .trade {
    display: grid;
    grid-template-columns: 1fr 18rem 20rem;
    grid-template-rows: 3.5rem 1fr auto;
    gap: 1px;
    height: 100dvh;
    background: var(--border);
    font-family: var(--font-mono);
    color: var(--text-primary);
    overflow: hidden;
    font-size: 0.75rem;
  }

  .trade--no-pair {
    grid-template-columns: 1fr 18rem 20rem;
  }

  .trade__header   { grid-column: 1 / -1; grid-row: 1; }
  .trade__graph    { grid-column: 1; grid-row: 2; }
  .trade__book     { grid-column: 2; grid-row: 2; }
  .trade__submit   { grid-column: 3; grid-row: 2; }
  .trade__orders   { grid-column: 1 / -1; grid-row: 3; }

  /* Loading / error states span full grid */
  .trade__loading {
    grid-column: 1 / -1;
    grid-row: 2 / 3;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    color: var(--text-muted);
  }

  .trade__error-text {
    color: var(--sell);
    font-size: 0.8rem;
  }

  .trade__retry {
    padding: 0.4rem 1.2rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    cursor: pointer;
  }

  .trade__retry:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  /* Mobile tabs - hidden on desktop */
  .mobile-tabs {
    display: none;
  }

  /* =========================================================
     CHART CLEANUP — Hide chart overlays to match THORDex
     ========================================================= */
  .trade__graph :global(.pair-chart__badges) { display: none; }
  .trade__graph :global(.pair-chart__pair) { display: none; }
  .trade__graph :global(.pair-chart__stats) { display: none; }
  .trade__graph :global(.pair-chart__head) {
    padding: 0.25rem 0.5rem;
    min-height: unset;
  }
  .trade__graph :global(.pair-chart__ranges) {
    margin-left: auto;
  }

  /* =========================================================
     PANEL (shared wrapper)
     ========================================================= */
  .panel {
    background: var(--bg-base);
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    min-height: 2rem;
  }

  .panel__title {
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  .panel__info-icon {
    color: var(--text-muted);
    cursor: help;
    display: inline-flex;
    align-items: center;
    opacity: 0.5;
    position: relative;
  }
  .panel__info-icon:hover {
    opacity: 0.9;
  }
  .panel__info-icon::after {
    content: attr(data-tip);
    position: absolute;
    left: 50%;
    bottom: calc(100% + 6px);
    transform: translateX(-50%);
    background: #1a1a1a;
    color: rgba(203, 213, 225, 0.85);
    font-size: 0.68rem;
    font-weight: 400;
    line-height: 1.4;
    letter-spacing: 0;
    text-transform: none;
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    white-space: normal;
    width: max-content;
    max-width: 20rem;
    pointer-events: none;
    opacity: 0;
    z-index: 9999;
  }
  .panel__info-icon:hover::after {
    opacity: 1;
  }

  .panel__count {
    font-size: 0.625rem;
    color: var(--text-muted);
    background: rgba(255, 255, 255, 0.04);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  /* =========================================================
     HEADER (THORDex-style)
     ========================================================= */
  .trade__header {
    display: flex;
    align-items: center;
    background: rgba(20, 20, 25, 0.8);
    padding: 0 1rem;
    gap: 0.75rem;
    z-index: 20;
  }

  .header__asset-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.6rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
    color: var(--text-primary);
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .header__asset-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.15);
  }

  .header__asset-icon {
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
  }

  .header__asset-info {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    line-height: 1.1;
  }

  .header__asset-ticker {
    font-family: var(--font-sans);
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .header__asset-chain {
    font-size: 0.55rem;
    color: var(--text-muted);
  }

  .header__asset-caret {
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .header__arrow {
    color: var(--text-muted);
    font-size: 0.85rem;
    flex-shrink: 0;
  }

  .header__stats {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    flex: 1;
    overflow: hidden;
    margin-left: 0.75rem;
  }

  .header__stat {
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
  }

  .header__stat-label {
    font-size: 0.55rem;
    color: var(--text-muted);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-family: var(--font-sans);
    font-weight: 500;
  }

  .header__stat-val {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .header__stat-val--accent {
    color: var(--buy);
  }

  .header__stat-val--positive {
    color: var(--buy);
  }

  .header__stat-val--negative {
    color: var(--sell);
  }

  .header__right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
    margin-left: auto;
  }

  .header__refresh {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    padding: 0.35rem;
    cursor: pointer;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }

  .header__refresh:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .header__wallet {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.4rem 0.8rem;
    background: var(--accent);
    border: none;
    border-radius: 0.5rem;
    color: #0a0a0a;
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .header__wallet:hover {
    opacity: 0.9;
  }

  .header__wallet.connected {
    background: rgba(96, 251, 208, 0.15);
    color: var(--buy);
  }

  /* =========================================================
     PAIR SELECTOR DROPDOWN
     ========================================================= */
  .pair-selector {
    position: relative;
  }

  .pair-selector__trigger {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.6rem;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 0.8rem;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .pair-selector__trigger:hover {
    background: var(--bg-elevated);
  }

  .pair-selector__name--dim {
    color: var(--text-muted);
    font-weight: 500;
  }

  .pair-selector__name {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .pair-selector__caret {
    color: var(--text-muted);
    transition: transform 0.15s;
  }

  .pair-selector.open .pair-selector__caret {
    transform: rotate(180deg);
  }

  .pair-selector__dropdown {
    position: absolute;
    top: calc(100% + 0.25rem);
    left: 0;
    width: 20rem;
    max-height: 24rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    z-index: 100;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .pair-selector__search {
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .pair-selector__search input {
    width: 100%;
    padding: 0.35rem 0.5rem;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    outline: none;
  }

  .pair-selector__search input:focus {
    border-color: var(--accent);
  }

  .pair-selector__search input::placeholder {
    color: var(--text-muted);
  }

  .pair-selector__list {
    overflow-y: auto;
    flex: 1;
  }

  .pair-selector__item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.75rem;
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
  }

  .pair-selector__item:hover {
    background: var(--bg-elevated);
  }

  .pair-selector__item.active {
    background: rgba(102, 126, 234, 0.1);
    color: var(--accent);
  }

  .pair-selector__item-name {
    font-weight: 600;
    color: var(--text-primary);
    flex: 1;
  }

  .pair-selector__item-count {
    color: var(--text-muted);
    font-size: 0.6rem;
  }

  .pair-selector__item-val {
    color: var(--buy);
    font-size: 0.6rem;
  }

  .pair-selector__empty {
    padding: 1.5rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.7rem;
  }

  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
  }

  /* =========================================================
     CHART (trade__graph)
     ========================================================= */
  .trade__graph {
    display: flex;
    min-height: 0;
    overflow: hidden;
    border-radius: 0.5rem;
    background: var(--bg-base);
  }

  .trade__graph :global(.pair-chart) {
    flex: 1 1 auto;
    min-height: 0;
  }

  /* =========================================================
     PAIRS DRAWER (overlay)
     ========================================================= */
  .pairs-drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 9998;
  }

  .pairs-drawer {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    width: 320px;
    max-width: 85vw;
    background: var(--bg-surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    z-index: 9999;
  }

  .pairs-drawer__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  .pairs-drawer__title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .pairs-drawer__close {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
  }

  .pairs-drawer__close:hover { color: var(--text-primary); }

  .pairs-drawer__search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  .pairs-drawer__search input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    outline: none;
  }

  .pairs-drawer__search input::placeholder { color: var(--text-muted); }

  .pairs-drawer__list {
    flex: 1;
    overflow-y: auto;
  }

  .pairs-drawer__row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    width: 100%;
    background: transparent;
    border: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
  }

  .pairs-drawer__row:hover { background: var(--bg-elevated); }
  .pairs-drawer__row.active { background: rgba(102, 126, 234, 0.08); }

  .pairs-drawer__name {
    flex: 1;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    font-weight: 600;
    color: var(--text-primary);
    flex-wrap: wrap;
  }

  .pairs-drawer__orders {
    color: var(--text-muted);
    min-width: 2rem;
    text-align: right;
  }

  .pairs-drawer__value {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.3rem;
    color: var(--buy);
    font-size: 0.7rem;
    min-width: 6.5rem;
    text-align: right;
    white-space: nowrap;
  }

  .pairs-drawer__separator {
    color: var(--text-muted);
  }

  .asset-icon {
    width: 0.9rem;
    height: 0.9rem;
    border-radius: 999px;
    object-fit: cover;
    flex: 0 0 auto;
    background: rgba(255, 255, 255, 0.04);
  }

  .asset-icon--price {
    width: 0.8rem;
    height: 0.8rem;
  }

  /* =========================================================
     ORDERBOOK (trade__book)
     ========================================================= */
  .trade__book {
    overflow: hidden;
  }

  .book-filters {
    display: flex;
    gap: 0.2rem;
  }

  .book-filter {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    padding: 0.15rem 0.3rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    transition: all 0.15s;
    opacity: 0.5;
  }

  .book-filter:hover {
    opacity: 0.8;
  }

  .book-filter.active {
    opacity: 1;
    border-color: var(--border);
    background: var(--bg-elevated);
  }

  .book__cols {
    display: flex;
    padding: 0.25rem 0.6rem;
    font-size: 0.55rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    text-transform: uppercase;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .book__cols span:first-child { flex: 1; }
  .book__cols span:nth-child(2) { width: 5.5rem; text-align: right; }
  .book__cols span:nth-child(3) { width: 5rem; text-align: right; }

  .book__empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: 0.7rem;
  }

  .book__asks {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column-reverse;
    min-height: 0;
  }

  .book__bids {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .book__side-empty {
    margin: auto;
    padding: 0.75rem;
    text-align: center;
    font-size: 0.68rem;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .book__row {
    display: flex;
    align-items: center;
    padding: 0 0.6rem;
    height: 1.25rem;
    position: relative;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.08s;
  }

  .book__row:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .book__row i {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    opacity: 0.15;
    pointer-events: none;
    transition: width 0.3s ease;
  }

  .book__row--sell i {
    background: var(--sell);
  }

  .book__row--buy i {
    background: var(--buy);
  }

  .book__price {
    flex: 1;
    position: relative;
    z-index: 1;
    font-weight: 500;
  }

  .book__row--sell .book__price {
    color: var(--sell);
  }

  .book__row--buy .book__price {
    color: var(--buy);
  }

  .book__amount {
    width: 5.5rem;
    text-align: right;
    position: relative;
    z-index: 1;
    color: var(--text-secondary);
  }

  .book__value {
    width: 5rem;
    text-align: right;
    position: relative;
    z-index: 1;
    color: var(--text-muted);
    font-size: 0.65rem;
  }

  /* Spread */
  .book__spread {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 0.35rem 0.6rem;
    background: var(--bg-surface);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .book__spread-price {
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .book__spread-usd {
    font-size: 0.65rem;
    color: var(--text-muted);
  }

  .book__spread-pct {
    font-size: 0.6rem;
    font-weight: 600;
    color: #d4a017;
    background: rgba(212, 160, 23, 0.1);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  /* =========================================================
     ORDER FORM (THORDex-style)
     ========================================================= */
  .trade__submit {
    overflow-y: auto;
    min-height: 0;
    background: #0a0a0f;
  }

  .submit-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .submit__tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .submit__tab {
    flex: 1;
    padding: 0.6rem;
    font-family: var(--font-sans);
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-muted);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: all 0.15s;
  }

  .submit__tab.active {
    color: var(--text-primary);
    border-bottom-color: var(--accent);
  }

  .submit__scroll {
    flex: 1;
    overflow-y: auto;
    padding: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .submit__bloc {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.75rem;
    padding: 0.6rem 0.7rem;
  }

  .submit__bloc-label {
    font-family: var(--font-sans);
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 0.3rem;
  }

  .submit__bloc-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .submit__bloc-input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 1.25rem;
    font-weight: 500;
    outline: none;
    min-width: 0;
  }

  .submit__bloc-input::placeholder { color: var(--text-muted); }
  .submit__bloc-input:disabled { opacity: 0.7; }
  .submit__bloc-input--rate { color: var(--accent); font-size: 1.1rem; }

  .submit__asset-btn {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.5rem;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .submit__asset-btn:hover { background: rgba(255, 255, 255, 0.1); }

  .submit__asset-icon {
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
  }

  .submit__rate-pair {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .submit__pct-row {
    display: flex;
    gap: 0.3rem;
    margin-top: 0.4rem;
  }

  .submit__pct-btn {
    padding: 0.15rem 0.3rem;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.2rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 0.6rem;
    font-weight: 500;
    cursor: pointer;
    transition: color 0.12s;
  }

  .submit__pct-btn:hover {
    color: var(--text-primary);
  }

  .submit__pct-btn.active {
    background: rgba(96, 251, 208, 0.12);
    border-color: rgba(96, 251, 208, 0.3);
    color: var(--buy);
  }

  .submit__swap-arrow {
    display: flex;
    justify-content: center;
    padding: 0.1rem;
    color: var(--text-muted);
  }

  .submit__ttl-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.4rem;
  }

  .submit__ttl-blocks {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    color: var(--text-muted);
  }

  .submit__ttl-row {
    display: flex;
    gap: 0.3rem;
  }

  .submit__ttl-btn {
    flex: 1;
    padding: 0.35rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.375rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.12s;
    text-align: center;
  }

  .submit__ttl-btn:hover { border-color: rgba(96, 251, 208, 0.2); }

  .submit__ttl-btn.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #0a0a0a;
    font-weight: 600;
  }

  .submit__recipient-input {
    width: 100%;
    padding: 0.5rem 0.6rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.5rem;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    outline: none;
    margin-top: 0.3rem;
    box-sizing: border-box;
  }

  .submit__recipient-input::placeholder { color: var(--text-muted); }
  .submit__recipient-input:focus { border-color: rgba(96, 251, 208, 0.3); }

  .submit__footer {
    padding: 0.75rem;
    flex-shrink: 0;
  }

  .submit__action-btn {
    width: 100%;
    padding: 0.75rem;
    font-family: var(--font-sans);
    font-size: 0.85rem;
    font-weight: 600;
    border: none;
    border-radius: 0.5rem;
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    background: var(--accent);
    color: #0a0a0f;
  }

  .submit__action-btn:hover:not(:disabled) { opacity: 0.9; }
  .submit__action-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .submit__quote-loading {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0;
    color: var(--text-muted);
    font-size: 0.65rem;
  }

  .submit__quote-result {
    padding: 0.4rem 0.5rem;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.5rem;
  }

  .submit__quote-row {
    display: flex;
    justify-content: space-between;
    padding: 0.2rem 0;
    font-size: 0.65rem;
    color: var(--text-muted);
  }

  .submit__quote-val { color: var(--text-primary); font-family: var(--font-mono); font-weight: 500; }
  .submit__quote-val.warn { color: #f59e0b; }

  .submit__msg {
    padding: 0.4rem 0.75rem;
    font-size: 0.65rem;
    margin: 0.3rem 0.75rem 0;
    border-radius: 0.375rem;
  }

  .submit__msg--error {
    background: rgba(229, 57, 53, 0.08);
    border: 1px solid rgba(229, 57, 53, 0.2);
    color: var(--sell);
  }

  .submit__msg--success {
    background: rgba(96, 251, 208, 0.08);
    border: 1px solid rgba(96, 251, 208, 0.2);
    color: var(--buy);
  }

  .submit__no-pair {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: 0.7rem;
    padding: 2rem;
    text-align: center;
  }

  /* =========================================================
     ORDERS (Full Width, THORDex-style)
     ========================================================= */
  .trade__orders {
    min-height: 0;
    max-height: 35vh;
    overflow: hidden;
    background: #0a0a0f;
    display: flex;
    flex-direction: column;
  }

  .orders__tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    padding: 0 0.75rem;
    flex-shrink: 0;
  }

  .orders__tab {
    padding: 0.5rem 1rem;
    font-family: var(--font-sans);
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: all 0.15s;
  }

  .orders__tab.active {
    color: var(--text-primary);
    border-bottom-color: var(--accent);
  }

  .orders__tab:hover:not(.active) {
    color: var(--text-secondary);
  }

  .orders__body {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .orders__cols {
    display: flex;
    padding: 0.35rem 1rem;
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    text-transform: uppercase;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .orders__cols span { flex: 1; }
  .orders__cols span:last-child { width: 3rem; flex: 0; }

  .orders__list {
    overflow-y: auto;
  }

  .orders__empty {
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.75rem;
    font-family: var(--font-sans);
  }

  .orders__row {
    display: flex;
    align-items: center;
    padding: 0.35rem 1rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    transition: background 0.08s;
  }

  .orders__row:hover {
    background: rgba(255, 255, 255, 0.02);
  }

  .orders__cell {
    flex: 1;
    font-size: 0.7rem;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .orders__cell--mono {
    font-family: var(--font-mono);
  }

  .orders__cell--dim {
    color: var(--text-muted);
  }

  .orders__cell--actions {
    width: 3rem;
    flex: 0;
    justify-content: flex-end;
    gap: 0.3rem;
  }

  .orders__pair-icon {
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
  }

  .orders__pair-icon--overlap {
    margin-left: -0.35rem;
  }

  .orders__side-tag {
    font-size: 0.6rem;
    font-weight: 600;
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
    text-transform: uppercase;
  }

  .orders__side-tag--buy {
    background: rgba(0, 204, 102, 0.1);
    color: var(--buy);
  }

  .orders__side-tag--sell {
    background: rgba(204, 51, 51, 0.1);
    color: var(--sell);
  }

  .orders__link {
    color: var(--text-muted);
    display: flex;
    align-items: center;
    transition: color 0.15s;
  }

  .orders__link:hover {
    color: var(--accent);
  }

  .orders__cancel {
    background: transparent;
    border: none;
    color: var(--sell);
    cursor: pointer;
    display: flex;
    align-items: center;
    padding: 0.1rem;
    opacity: 0.6;
    transition: opacity 0.15s;
  }

  .orders__cancel:hover:not(:disabled) { opacity: 1; }
  .orders__cancel:disabled { opacity: 0.3; cursor: not-allowed; }

  /* =========================================================
     SPINNER
     ========================================================= */
  .spinner {
    width: 28px;
    height: 28px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .spinner.small {
    width: 18px;
    height: 18px;
  }

  .spinner.tiny {
    width: 12px;
    height: 12px;
    border-width: 1.5px;
    display: inline-block;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .spinning {
    animation: spin 1s linear infinite;
  }

  /* =========================================================
     TOAST
     ========================================================= */
  .toast {
    position: fixed;
    bottom: 1.5rem;
    left: 50%;
    transform: translateX(-50%);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-primary);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 1rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
    z-index: 1000;
  }

  /* =========================================================
     RESPONSIVE: Mobile (<1170px)
     ========================================================= */
  @media (max-width: 1170px) {
    .trade {
      display: flex;
      flex-direction: column;
      height: 100dvh;
      grid-template-columns: unset;
      grid-template-rows: unset;
    }

    .trade--no-pair {
      grid-template-columns: unset;
    }

    .trade__header {
      flex-shrink: 0;
      min-height: 3.25rem;
    }

    .mobile-tabs {
      display: flex;
      border-bottom: 1px solid var(--border);
      background: var(--bg-surface);
      flex-shrink: 0;
    }

    .mobile-tab {
      flex: 1;
      padding: 0.45rem;
      font-family: var(--font-mono);
      font-size: 0.65rem;
      font-weight: 600;
      color: var(--text-muted);
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: all 0.15s;
    }

    .mobile-tab.active {
      color: var(--text-primary);
      border-bottom-color: var(--accent);
    }

    .mobile-hidden {
      display: none !important;
    }

    .trade__graph,
    .trade__book,
    .trade__submit,
    .trade__orders {
      flex: 1;
      min-height: 0;
    }

    .trade__loading {
      flex: 1;
    }

    /* Stack header on very small */
    .header__stats {
      display: none;
    }
  }

  @media (max-width: 600px) {
    .trade__header {
      padding: 0 0.4rem;
      gap: 0.4rem;
    }

    .header__asset-btn {
      padding: 0.2rem 0.4rem;
    }

    .header__asset-ticker {
      font-size: 0.7rem;
    }

    .header__asset-chain {
      display: none;
    }

    .header__arrow {
      font-size: 0.7rem;
    }

    .header__wallet {
      font-size: 0.6rem;
      padding: 0.25rem 0.5rem;
    }

    .pair-selector__dropdown {
      width: calc(100vw - 1rem);
      left: -0.5rem;
    }
  }

  /* =========================================================
     SCROLLBAR STYLING
     ========================================================= */
  .pairs-list::-webkit-scrollbar,
  .book__asks::-webkit-scrollbar,
  .book__bids::-webkit-scrollbar,
  .orders__list::-webkit-scrollbar,
  .trade__submit::-webkit-scrollbar,
  .pair-selector__list::-webkit-scrollbar {
    width: 4px;
  }

  .pairs-list::-webkit-scrollbar-track,
  .book__asks::-webkit-scrollbar-track,
  .book__bids::-webkit-scrollbar-track,
  .orders__list::-webkit-scrollbar-track,
  .trade__submit::-webkit-scrollbar-track,
  .pair-selector__list::-webkit-scrollbar-track {
    background: transparent;
  }

  .pairs-list::-webkit-scrollbar-thumb,
  .book__asks::-webkit-scrollbar-thumb,
  .book__bids::-webkit-scrollbar-thumb,
  .orders__list::-webkit-scrollbar-thumb,
  .trade__submit::-webkit-scrollbar-thumb,
  .pair-selector__list::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.08);
    border-radius: 2px;
  }

  .pairs-list::-webkit-scrollbar-thumb:hover,
  .book__asks::-webkit-scrollbar-thumb:hover,
  .book__bids::-webkit-scrollbar-thumb:hover,
  .orders__list::-webkit-scrollbar-thumb:hover,
  .trade__submit::-webkit-scrollbar-thumb:hover,
  .pair-selector__list::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.15);
  }
</style>
