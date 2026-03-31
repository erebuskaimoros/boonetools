<script>
  import { onMount, onDestroy } from 'svelte';
  import { CHART_RANGE_OPTIONS, thorchainChartDataProvider } from './chart-data.js';
  import { normalizeAsset, getChainFromAsset } from '$lib/utils/blockchain.js';

  export let pair = null;
  export let marketPrice = null;
  export let refreshKey = 0;

  let selectedRange = '7D';
  let chartData = null;
  let loading = false;
  let error = '';
  let requestToken = 0;

  let chartHost;
  let chart = null;
  let disposeChart = null;
  let resizeObserver = null;
  let volumeIndicatorPaneId = null;
  let componentDisposed = false;
  let lastAppliedDatasetKey = '';
  let lastAppliedLiveKey = '';
  let liveContextKey = '';
  let liveCandle = null;
  let liveCandleBucketKey = '';
  let liveCandleBaseKey = '';
  let baseChartCandles = [];

  function formatAsset(asset) {
    return normalizeAsset(asset);
  }

  function shortAsset(asset) {
    const normalized = normalizeAsset(asset);
    const parts = normalized.split('.');
    return parts.length > 1 ? parts[1] : parts[0];
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

  function formatPrice(value) {
    if (!(value > 0)) return '--';
    if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (value >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
    if (value >= 0.001) return value.toLocaleString('en-US', { maximumFractionDigits: 6 });
    return value.toExponential(4);
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) return '--';
    const prefix = value > 0 ? '+' : '';
    return `${prefix}${value.toFixed(2)}%`;
  }

  function getChangePercent(candles) {
    if (!Array.isArray(candles) || candles.length < 2) return 0;

    const first = candles[0]?.close ?? 0;
    const last = candles.at(-1)?.close ?? 0;

    if (!(first > 0) || !(last > 0)) return 0;
    return ((last / first) - 1) * 100;
  }

  function getSpotGapPercent(seriesClose, spotPrice) {
    if (!(seriesClose > 0) || !(spotPrice > 0)) return null;
    return ((spotPrice / seriesClose) - 1) * 100;
  }

  function getPricePrecision(value) {
    if (!(value > 0)) return 4;
    if (value >= 1000) return 2;
    if (value >= 1) return 4;
    if (value >= 0.001) return 6;
    return 8;
  }

  function getVolumePrecision(value) {
    if (!(value > 0)) return 2;
    return value >= 1 ? 2 : 4;
  }

  function formatIntervalLabel(interval) {
    switch (String(interval || '').toLowerCase()) {
      case '5min':
        return '5M';
      case 'hour':
        return '1H';
      case 'day':
        return '1D';
      case 'week':
        return '1W';
      case 'month':
        return '1M';
      case 'quarter':
        return '3M';
      case 'year':
        return '1Y';
      default:
        return '';
    }
  }

  function toKlineCandle(candle) {
    return {
      timestamp: candle.time,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume ?? 0)
    };
  }

  function getCurrentBucketStart(durationMs, timestamp = Date.now()) {
    if (!(durationMs > 0)) return null;
    return Math.floor(timestamp / durationMs) * durationMs;
  }

  function splitCanonicalCandles(candles, durationMs) {
    const activeBucketStart = getCurrentBucketStart(durationMs);
    if (!Array.isArray(candles) || candles.length === 0) {
      return { closedCandles: [], activeBucketStart };
    }

    return {
      closedCandles: activeBucketStart
        ? candles.filter((candle) => Number(candle?.time ?? 0) < activeBucketStart)
        : [...candles],
      activeBucketStart
    };
  }

  function resetLiveCandleState() {
    liveCandle = null;
    liveCandleBucketKey = '';
    liveCandleBaseKey = '';
    baseChartCandles = [];
    lastAppliedDatasetKey = '';
    lastAppliedLiveKey = '';
  }

  function syncLiveCandle(forceReset = false) {
    const durationMs = chartData?.range?.durationMs ?? 0;
    const { closedCandles, activeBucketStart } = splitCanonicalCandles(chartData?.candles ?? [], durationMs);
    let canonicalClosedCandles = [...closedCandles];
    const activeVolumeValue = Number(chartData?.activeVolume);
    const activeVolume = Number.isFinite(activeVolumeValue) && activeVolumeValue >= 0
      ? activeVolumeValue
      : null;

    if (
      liveCandle &&
      activeBucketStart &&
      liveCandle.time < activeBucketStart &&
      !canonicalClosedCandles.some((candle) => candle.time === liveCandle.time)
    ) {
      canonicalClosedCandles = [...canonicalClosedCandles, { ...liveCandle }]
        .sort((left, right) => left.time - right.time);
    }

    baseChartCandles = canonicalClosedCandles;

    const livePrice = Number(marketPrice);
    if (!(livePrice > 0) || !(activeBucketStart > 0)) {
      liveCandle = null;
      liveCandleBucketKey = '';
      liveCandleBaseKey = '';
      return;
    }

    const previousClose = Number(canonicalClosedCandles.at(-1)?.close ?? livePrice);
    if (!(previousClose > 0)) {
      liveCandle = null;
      return;
    }

    const bucketKey = `${liveContextKey}|${activeBucketStart}`;
    const baseKey = [
      bucketKey,
      canonicalClosedCandles.length,
      canonicalClosedCandles.at(-1)?.time ?? '',
      canonicalClosedCandles.at(-1)?.close ?? ''
    ].join('|');

    if (forceReset || !liveCandle || liveCandleBucketKey !== bucketKey || liveCandleBaseKey !== baseKey) {
      liveCandle = {
        time: activeBucketStart,
        open: previousClose,
        high: Math.max(previousClose, livePrice),
        low: Math.min(previousClose, livePrice),
        close: livePrice,
        volume: activeVolume ?? 0
      };

      liveCandleBucketKey = bucketKey;
      liveCandleBaseKey = baseKey;
      return;
    }

    liveCandle = {
      ...liveCandle,
      high: Math.max(Number(liveCandle.high), livePrice),
      low: Math.min(Number(liveCandle.low), livePrice),
      close: livePrice,
      volume: activeVolume ?? Number(liveCandle.volume ?? 0)
    };
  }

  function buildChartStyles() {
    return {
      grid: {
        horizontal: { color: 'rgba(148, 163, 184, 0.08)' },
        vertical: { color: 'rgba(148, 163, 184, 0.05)' }
      },
      candle: {
        bar: {
          upColor: '#22c55e',
          downColor: '#ef4444',
          noChangeColor: '#94a3b8',
          upBorderColor: '#22c55e',
          downBorderColor: '#ef4444',
          noChangeBorderColor: '#94a3b8',
          upWickColor: '#22c55e',
          downWickColor: '#ef4444',
          noChangeWickColor: '#94a3b8'
        },
        tooltip: {
          rect: {
            color: 'rgba(9, 13, 19, 0.92)',
            borderColor: 'rgba(148, 163, 184, 0.16)'
          },
          text: {
            color: '#e2e8f0'
          }
        },
        priceMark: {
          high: { color: '#94a3b8' },
          low: { color: '#94a3b8' },
          last: {
            upColor: '#22c55e',
            downColor: '#ef4444',
            noChangeColor: '#94a3b8',
            line: { show: true, size: 1, style: 'dashed' },
            text: {
              show: true,
              color: '#f8fafc',
              size: 11,
              family: 'IBM Plex Sans, system-ui, sans-serif',
              weight: 600,
              paddingLeft: 6,
              paddingTop: 3,
              paddingRight: 6,
              paddingBottom: 3,
              borderRadius: 2,
              borderColor: 'transparent',
              borderSize: 0,
              borderStyle: 'solid',
              borderDashedValue: [0, 0]
            }
          }
        }
      },
      indicator: {
        tooltip: {
          text: { color: '#cbd5e1' }
        }
      },
      xAxis: {
        axisLine: { color: 'rgba(148, 163, 184, 0.18)' },
        tickLine: { color: 'rgba(148, 163, 184, 0.18)' },
        tickText: { color: 'rgba(226, 232, 240, 0.62)' }
      },
      yAxis: {
        axisLine: { color: 'rgba(148, 163, 184, 0.18)' },
        tickLine: { color: 'rgba(148, 163, 184, 0.18)' },
        tickText: { color: 'rgba(226, 232, 240, 0.62)' }
      },
      separator: {
        color: 'rgba(148, 163, 184, 0.14)'
      },
      crosshair: {
        horizontal: {
          line: { color: 'rgba(148, 163, 184, 0.4)' },
          text: {
            color: '#f8fafc',
            borderColor: '#0f172a',
            backgroundColor: '#0f172a'
          }
        },
        vertical: {
          line: { color: 'rgba(148, 163, 184, 0.32)' },
          text: {
            color: '#f8fafc',
            borderColor: '#0f172a',
            backgroundColor: '#0f172a'
          }
        }
      }
    };
  }

  async function ensureChart() {
    if (chart || !chartHost) return;

    const { init, dispose } = await import('klinecharts');
    if (componentDisposed || chart || !chartHost) return;

    disposeChart = dispose;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';

    chart = init(chartHost, {
      locale: 'en-US',
      timezone,
      styles: 'dark'
    });

    if (!chart) {
      error = 'Failed to initialize chart';
      return;
    }

    chart.setStyles(buildChartStyles());
    chart.setOffsetRightDistance(16);
    chart.setLeftMinVisibleBarCount(8);
    chart.setRightMinVisibleBarCount(6);
    chart.setBarSpace(8);
    chart.setZoomEnabled(true);
    chart.setScrollEnabled(true);
    volumeIndicatorPaneId = chart.createIndicator('VOL', false, { height: 88, minHeight: 56 });

    resizeObserver = new ResizeObserver(() => {
      chart?.resize();
    });
    resizeObserver.observe(chartHost);

    applyChartDataset();
    applyLivePrice();
  }

  function clearChart() {
    if (!chart) return;
    chart.clearData();
    resetLiveCandleState();
  }

  function applyChartDataset() {
    if (!chart) return;

    const candles = baseChartCandles;
    if (candles.length === 0) {
      clearChart();
      return;
    }

    const latest = candles.at(-1);
    const datasetKey = [
      pair?.sourceAsset ?? '',
      pair?.targetAsset ?? '',
      selectedRange,
      candles.length,
      latest?.time ?? '',
      latest?.close ?? '',
      latest?.volume ?? ''
    ].join('|');

    if (datasetKey === lastAppliedDatasetKey) return;

    chart.applyNewData(candles.map(toKlineCandle));
    chart.setPriceVolumePrecision(
      getPricePrecision(chartData?.latest?.close ?? marketPrice),
      getVolumePrecision(latest?.volume ?? 0)
    );
    chart.scrollToRealTime();

    lastAppliedDatasetKey = datasetKey;
    lastAppliedLiveKey = '';
  }

  function applyLivePrice() {
    if (!chart || !liveCandle) return;

    const liveKey = `${liveCandle.time}|${liveCandle.open}|${liveCandle.close}|${liveCandle.high}|${liveCandle.low}|${liveCandle.volume}`;
    if (liveKey === lastAppliedLiveKey) return;

    chart.updateData(toKlineCandle(liveCandle));
    chart.setPriceVolumePrecision(getPricePrecision(liveCandle.close), getVolumePrecision(liveCandle.volume));
    lastAppliedLiveKey = liveKey;
  }

  async function loadChartData(currentPair, rangeKey, forceRefresh = false) {
    if (!currentPair?.sourceAsset || !currentPair?.targetAsset) {
      chartData = null;
      error = '';
      loading = false;
      clearChart();
      return;
    }

    const token = ++requestToken;
    loading = true;
    error = '';

    try {
      const nextData = await thorchainChartDataProvider.getPairSeries(currentPair, rangeKey, { force: forceRefresh });
      if (token !== requestToken) return;
      chartData = nextData;
    } catch (err) {
      if (token !== requestToken) return;
      chartData = null;
      error = err.message || 'Failed to load chart history';
    }

    if (token === requestToken) {
      loading = false;
    }
  }

  onMount(() => {
    componentDisposed = false;
    ensureChart();
  });

  onDestroy(() => {
    componentDisposed = true;
    resizeObserver?.disconnect();
    resizeObserver = null;
    volumeIndicatorPaneId = null;
    if (disposeChart && chartHost) {
      disposeChart(chartHost);
    }
    chart = null;
  });

  $: chartKey = pair ? `${pair.sourceAsset}|${pair.targetAsset}|${selectedRange}` : '';
  $: nextLiveContextKey = chartKey;

  $: if (nextLiveContextKey !== liveContextKey) {
    liveContextKey = nextLiveContextKey;
    resetLiveCandleState();
  }

  $: if (chartHost) {
    ensureChart();
  }

  $: if (chartKey) {
    loadChartData(pair, selectedRange);
  } else {
    chartData = null;
    error = '';
    loading = false;
    clearChart();
  }

  $: if (refreshKey && chartKey) {
    loadChartData(pair, selectedRange, true);
  }

  $: if (chartData && chartKey && marketPrice !== undefined) {
    syncLiveCandle(false);
  }

  $: if (chart && chartData) {
    applyChartDataset();
  }

  $: if (chart && liveCandle) {
    applyLivePrice();
  }

  $: pairLabel = pair
    ? `${formatAsset(pair.sourceAsset)} / ${formatAsset(pair.targetAsset)}`
    : 'Select a market';

  $: chartCandles = liveCandle
    ? [...baseChartCandles.filter((candle) => candle.time !== liveCandle.time), liveCandle]
    : baseChartCandles;
  $: chartChange = getChangePercent(chartCandles);
  $: chartTone = chartChange >= 0 ? 'up' : 'down';
  $: seriesClose = chartCandles.at(-1)?.close ?? null;
  $: spotGapPercent = getSpotGapPercent(seriesClose, marketPrice);
  $: candleIntervalLabel = formatIntervalLabel(chartData?.range?.interval);
</script>

<div class="pair-chart">
  <div class="pair-chart__head">
    <div class="pair-chart__meta">
      <div class="pair-chart__badges">
        <span class="pair-chart__badge">TC Native</span>
        <span class="pair-chart__badge pair-chart__badge--muted">KLineChart</span>
        {#if chartData?.range}
          <span class="pair-chart__badge pair-chart__badge--muted">{chartData.range.label}</span>
        {/if}
        {#if candleIntervalLabel}
          <span class="pair-chart__badge pair-chart__badge--muted">{candleIntervalLabel} Candle</span>
        {/if}
      </div>
      <div class="pair-chart__pair">
        {#if pair}
          <span class="pair-chart__pair-asset">
            <img class="pair-chart__pair-icon" src={getAssetIcon(pair.sourceAsset)} alt={shortAsset(pair.sourceAsset)} />
            {formatAsset(pair.sourceAsset)}
          </span>
          <span class="pair-chart__pair-separator">/</span>
          <span class="pair-chart__pair-asset">
            <img class="pair-chart__pair-icon" src={getAssetIcon(pair.targetAsset)} alt={shortAsset(pair.targetAsset)} />
            {formatAsset(pair.targetAsset)}
          </span>
        {:else}
          {pairLabel}
        {/if}
        <span class="pair-chart__info-icon" data-tip={chartData?.note || 'Pair-driven chart built from THORChain-native history.'}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        </span>
      </div>
    </div>

    <div class="pair-chart__ranges">
      {#each CHART_RANGE_OPTIONS as option}
        <button
          class="pair-chart__range"
          class:active={option.key === selectedRange}
          on:click={() => { selectedRange = option.key; }}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </div>

  <div class="pair-chart__stats">
    <div class="pair-chart__stat">
      <span class="pair-chart__stat-label">Last Close</span>
      <span class="pair-chart__stat-value">{formatPrice(seriesClose)}</span>
    </div>
    <div class="pair-chart__stat">
      <span class="pair-chart__stat-label">Range Change</span>
      <span class="pair-chart__stat-value" class:pair-chart__stat-value--up={chartTone === 'up'} class:pair-chart__stat-value--down={chartTone === 'down'}>
        {formatPercent(chartChange)}
      </span>
    </div>
    <div class="pair-chart__stat">
      <span class="pair-chart__stat-label">Live Spot</span>
      <span class="pair-chart__stat-value">{formatPrice(marketPrice)}</span>
    </div>
    <div class="pair-chart__stat">
      <span class="pair-chart__stat-label">Spot Gap</span>
      <span class="pair-chart__stat-value">
        {spotGapPercent === null ? '--' : formatPercent(spotGapPercent)}
      </span>
    </div>
  </div>

  <div class="pair-chart__surface">
    <div class="pair-chart__canvas" bind:this={chartHost}></div>

    {#if !pair}
      <div class="pair-chart__overlay">
        <div class="pair-chart__overlay-title">Select a market</div>
        <div class="pair-chart__overlay-copy">Choose a THORChain pair to load candles.</div>
      </div>
    {:else if loading}
      <div class="pair-chart__overlay">
        <div class="pair-chart__spinner"></div>
        <div class="pair-chart__overlay-copy">Loading THORChain candles...</div>
      </div>
    {:else if error}
      <div class="pair-chart__overlay">
        <div class="pair-chart__overlay-title">Chart unavailable</div>
        <div class="pair-chart__overlay-copy">{error}</div>
      </div>
    {:else if chartCandles.length === 0}
      <div class="pair-chart__overlay">
        <div class="pair-chart__overlay-title">No history</div>
        <div class="pair-chart__overlay-copy">THORChain did not return candle history for this range.</div>
      </div>
    {/if}
  </div>
</div>

<style>
  .pair-chart {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  .pair-chart__head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
  }

  .pair-chart__meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.28rem;
  }

  .pair-chart__badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .pair-chart__badge {
    display: inline-flex;
    align-items: center;
    border: 1px solid rgba(56, 189, 248, 0.26);
    background: rgba(56, 189, 248, 0.11);
    color: rgba(186, 230, 253, 0.94);
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 0.18rem 0.45rem;
    border-radius: 999px;
  }

  .pair-chart__badge--muted {
    border-color: rgba(148, 163, 184, 0.18);
    background: rgba(15, 23, 42, 0.7);
    color: rgba(203, 213, 225, 0.78);
  }

  .pair-chart__pair {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    color: rgba(248, 250, 252, 0.98);
    font-size: 1.08rem;
    letter-spacing: 0.01em;
  }

  .pair-chart__pair-asset {
    display: inline-flex;
    align-items: center;
    gap: 0.38rem;
  }

  .pair-chart__pair-separator {
    color: rgba(148, 163, 184, 0.74);
  }

  .pair-chart__pair-icon {
    width: 1rem;
    height: 1rem;
    border-radius: 999px;
    object-fit: contain;
    flex-shrink: 0;
  }

  .pair-chart__info-icon {
    color: var(--text-muted, rgba(148, 163, 184, 0.45));
    cursor: help;
    display: inline-flex;
    align-items: center;
    position: relative;
  }
  .pair-chart__info-icon::after {
    content: attr(data-tip);
    position: absolute;
    left: 50%;
    top: calc(100% + 6px);
    transform: translateX(-50%);
    background: #1a1a1a;
    color: rgba(203, 213, 225, 0.85);
    font-size: 0.68rem;
    line-height: 1.4;
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    white-space: normal;
    width: max-content;
    max-width: 22rem;
    pointer-events: none;
    opacity: 0;
    z-index: 100;
  }
  .pair-chart__info-icon:hover::after {
    opacity: 1;
  }

  .pair-chart__ranges {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem;
    border-radius: 999px;
    border: 1px solid rgba(148, 163, 184, 0.14);
    background: rgba(9, 13, 19, 0.9);
  }

  .pair-chart__range {
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: rgba(203, 213, 225, 0.68);
    font-size: 0.74rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0.42rem 0.72rem;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, transform 120ms ease;
  }

  .pair-chart__range:hover {
    color: rgba(248, 250, 252, 0.92);
  }

  .pair-chart__range.active {
    background: linear-gradient(135deg, rgba(16, 185, 129, 0.2), rgba(56, 189, 248, 0.2));
    color: rgba(248, 250, 252, 0.96);
  }

  .pair-chart__stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .pair-chart__stat {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.28rem;
    padding: 0.78rem 0.92rem;
    border-radius: 0.9rem;
    background: rgba(9, 13, 19, 0.74);
    border: 1px solid rgba(148, 163, 184, 0.11);
  }

  .pair-chart__stat-label {
    color: rgba(148, 163, 184, 0.7);
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .pair-chart__stat-value {
    color: rgba(248, 250, 252, 0.96);
    font-size: 0.94rem;
  }

  .pair-chart__stat-value--up {
    color: #4ade80;
  }

  .pair-chart__stat-value--down {
    color: #f87171;
  }

  .pair-chart__surface {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    border-radius: 1.1rem;
    overflow: hidden;
    border: 1px solid rgba(148, 163, 184, 0.14);
    background:
      radial-gradient(circle at top left, rgba(15, 118, 110, 0.14), transparent 42%),
      radial-gradient(circle at top right, rgba(14, 116, 144, 0.12), transparent 36%),
      linear-gradient(180deg, rgba(8, 12, 18, 0.98), rgba(6, 10, 16, 0.98));
  }

  .pair-chart__canvas {
    width: 100%;
    height: 100%;
    min-height: 0;
  }

  .pair-chart__overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 0.6rem;
    padding: 1.25rem;
    background: rgba(7, 10, 15, 0.58);
    backdrop-filter: blur(2px);
    text-align: center;
  }

  .pair-chart__overlay-title {
    color: rgba(248, 250, 252, 0.96);
    font-size: 1rem;
    letter-spacing: 0.01em;
  }

  .pair-chart__overlay-copy {
    color: rgba(203, 213, 225, 0.76);
    font-size: 0.84rem;
    line-height: 1.45;
    max-width: 26rem;
  }

  .pair-chart__spinner {
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 999px;
    border: 2px solid rgba(56, 189, 248, 0.18);
    border-top-color: rgba(56, 189, 248, 0.92);
    animation: pair-chart-spin 0.7s linear infinite;
  }

  @keyframes pair-chart-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 860px) {
    .pair-chart__head {
      flex-direction: column;
    }

    .pair-chart__ranges {
      width: 100%;
      justify-content: space-between;
    }

    .pair-chart__range {
      flex: 1 1 0;
    }

    .pair-chart__stats {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
