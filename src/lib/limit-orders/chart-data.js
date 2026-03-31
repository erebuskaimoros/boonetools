import { midgard } from '../api/midgard.js';
import { normalizeAsset } from '$lib/utils/blockchain.js';

export const CHART_RANGE_OPTIONS = [
  { key: '24H', label: '24H', interval: '5min', count: 288, durationMs: 5 * 60 * 1000 },
  { key: '7D', label: '7D', interval: 'hour', count: 168, durationMs: 60 * 60 * 1000 },
  { key: '30D', label: '30D', interval: 'day', count: 30, durationMs: 24 * 60 * 60 * 1000 },
  { key: '90D', label: '90D', interval: 'day', count: 90, durationMs: 24 * 60 * 60 * 1000 },
  { key: '1Y', label: '1Y', interval: 'week', count: 52, durationMs: 7 * 24 * 60 * 60 * 1000 }
];

const RANGE_BY_KEY = new Map(CHART_RANGE_OPTIONS.map((option) => [option.key, option]));
const CACHE_TTL_MS = 60_000;
const USD_CENTS_SCALE = 100;

function getRangeConfig(rangeKey) {
  return RANGE_BY_KEY.get(rangeKey) ?? CHART_RANGE_OPTIONS[1];
}

function parsePositiveFloat(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveRunePrice(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeFloat(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseNonNegativeUsdCents(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed / USD_CENTS_SCALE : null;
}

function parseBucketBounds(interval, durationMs) {
  const rawStart = Number(interval?.startTime ?? 0) * 1000;
  const rawEnd = Number(interval?.endTime ?? 0) * 1000;
  const endTime = rawEnd > 0
    ? rawEnd
    : (rawStart > 0 && durationMs > 0 ? rawStart + durationMs : 0);
  const startTime = rawStart > 0
    ? rawStart
    : (endTime > 0 && durationMs > 0 ? endTime - durationMs : 0);

  if (!(startTime > 0) || !(endTime > startTime)) return null;

  return {
    time: startTime,
    bucketEnd: endTime
  };
}

function normalizePoolHistory(data, durationMs) {
  const intervals = Array.isArray(data?.intervals) ? data.intervals : [];

  return intervals
    .map((interval) => {
      const bucket = parseBucketBounds(interval, durationMs);
      const open = parsePositiveFloat(interval?.openPriceUSD ?? interval?.assetPriceUSD);
      const high = parsePositiveFloat(interval?.highPriceUSD ?? interval?.closePriceUSD ?? interval?.assetPriceUSD);
      const low = parsePositiveFloat(interval?.lowPriceUSD ?? interval?.closePriceUSD ?? interval?.assetPriceUSD);
      const close = parsePositiveFloat(interval?.closePriceUSD ?? interval?.assetPriceUSD);

      if (!bucket || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) return null;

      return { ...bucket, open, high, low, close };
    })
    .filter(Boolean)
    .sort((left, right) => left.time - right.time);
}

function normalizeRuneHistory(data, durationMs) {
  const intervals = Array.isArray(data?.intervals) ? data.intervals : [];
  let previousClose = null;

  return intervals
    .map((interval) => {
      const bucket = parseBucketBounds(interval, durationMs);
      const close = parsePositiveRunePrice(interval?.runePriceUSD);

      if (!bucket || !(close > 0)) return null;

      const open = previousClose ?? close;
      const high = Math.max(open, close);
      const low = Math.min(open, close);
      previousClose = close;

      return { ...bucket, open, high, low, close };
    })
    .filter(Boolean)
    .sort((left, right) => left.time - right.time);
}

function normalizeSwapHistory(data, durationMs) {
  const intervals = Array.isArray(data?.intervals) ? data.intervals : [];

  return intervals
    .map((interval) => {
      const bucket = parseBucketBounds(interval, durationMs);
      const volume = parseNonNegativeUsdCents(interval?.totalVolumeUSD);
      const count = parseNonNegativeFloat(interval?.totalCount);

      if (!bucket || volume === null || count === null) return null;

      return { ...bucket, volume, count };
    })
    .filter(Boolean)
    .sort((left, right) => left.time - right.time);
}

function enforceContinuousCandles(candles) {
  const values = Array.isArray(candles) ? candles : [];
  if (values.length === 0) return [];

  return values
    .slice()
    .sort((left, right) => left.time - right.time)
    .map((candle, index, list) => {
      if (index === 0) {
        return {
          ...candle,
          high: Math.max(Number(candle.high), Number(candle.open), Number(candle.close)),
          low: Math.min(Number(candle.low), Number(candle.open), Number(candle.close))
        };
      }

      const previous = list[index - 1];
      const open = Number(previous?.close ?? candle.open);
      const close = Number(candle.close);
      const high = Math.max(Number(candle.high), open, close);
      const low = Math.min(Number(candle.low), open, close);

      return {
        ...candle,
        open,
        high,
        low
      };
    });
}

function getCurrentBucketStart(durationMs, timestamp = Date.now()) {
  if (!(durationMs > 0)) return null;
  return Math.floor(timestamp / durationMs) * durationMs;
}

function dropInProgressCandles(candles, durationMs) {
  const activeBucketStart = getCurrentBucketStart(durationMs);
  if (!(activeBucketStart > 0)) return Array.isArray(candles) ? candles : [];

  return (Array.isArray(candles) ? candles : []).filter((candle) => Number(candle?.time ?? 0) < activeBucketStart);
}

function splitSeriesByActiveBucket(series, durationMs) {
  const activeBucketStart = getCurrentBucketStart(durationMs);
  const values = Array.isArray(series) ? series : [];

  if (!(activeBucketStart > 0)) {
    return {
      closedSeries: [...values],
      activeItem: null,
      activeBucketStart: null
    };
  }

  const closedSeries = [];
  let activeItem = null;

  for (const item of values) {
    const time = Number(item?.time ?? 0);
    if (!(time > 0)) continue;

    if (time < activeBucketStart) {
      closedSeries.push(item);
      continue;
    }

    if (!activeItem || time < activeItem.time) {
      activeItem = item;
    }
  }

  return {
    closedSeries,
    activeItem,
    activeBucketStart
  };
}

function alignPairCandles(sourceCandles, targetCandles) {
  const targetByTime = new Map(targetCandles.map((candle) => [candle.time, candle]));

  return sourceCandles
    .map((candle) => {
      const quoteCandle = targetByTime.get(candle.time);
      if (!quoteCandle) return null;
      if (!(quoteCandle.open > 0) || !(quoteCandle.high > 0) || !(quoteCandle.low > 0) || !(quoteCandle.close > 0)) return null;

      const open = candle.open / quoteCandle.open;
      const close = candle.close / quoteCandle.close;
      // Cross-pool intrabar highs/lows are not synchronized, so keep synthetic
      // wicks conservative and derived from the interval boundary ratios only.
      const high = Math.max(open, close);
      const low = Math.min(open, close);

      if (!(open > 0) || !(close > 0) || !(high > 0) || !(low > 0)) return null;

      return {
        time: candle.time,
        open,
        high,
        low,
        close
      };
    })
    .filter((candle) => (
      candle &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) &&
      candle.open > 0 &&
      candle.high > 0 &&
      candle.low > 0 &&
      candle.close > 0
    ))
    .sort((left, right) => left.time - right.time);
}

function combineVolumeSeries(seriesList) {
  const combined = new Map();

  for (const series of seriesList) {
    for (const item of Array.isArray(series) ? series : []) {
      const time = Number(item?.time ?? 0);
      const volume = parseNonNegativeFloat(item?.volume);
      const count = parseNonNegativeFloat(item?.count);

      if (!(time > 0) || volume === null || count === null) continue;

      const current = combined.get(time) ?? { time, volume: 0, count: 0 };
      current.volume += volume;
      current.count += count;
      combined.set(time, current);
    }
  }

  return Array.from(combined.values()).sort((left, right) => left.time - right.time);
}

function scaleVolumeSeries(series, multiplier) {
  if (!(multiplier > 0) || multiplier === 1) {
    return Array.isArray(series) ? series : [];
  }

  return (Array.isArray(series) ? series : []).map((item) => ({
    ...item,
    volume: Number(item.volume ?? 0) * multiplier,
    count: Number(item.count ?? 0) * multiplier
  }));
}

function getVolumePools(pair) {
  const source = normalizeAsset(pair?.sourceAsset ?? '');
  const target = normalizeAsset(pair?.targetAsset ?? '');
  const pools = [];

  if (source && source !== 'THOR.RUNE') {
    pools.push(pair.sourceAsset);
  }

  if (target && target !== 'THOR.RUNE' && target !== source) {
    pools.push(pair.targetAsset);
  }

  return pools;
}

function buildSeriesNote(pair, sourceKind, targetKind, volumePoolCount = 0) {
  const source = normalizeAsset(pair?.sourceAsset ?? '');
  const target = normalizeAsset(pair?.targetAsset ?? '');
  const volumeNote = volumePoolCount > 1
    ? ' Volume bars use a blended half-sum of THORChain swap volume across both underlying pools in USD.'
    : ' Volume bars show THORChain swap volume for the selected pool in USD.';

  if (source === 'THOR.RUNE' || target === 'THOR.RUNE') {
    return `THORChain pool price is the source of truth. The current candle is rebuilt from live pool ratio, and historical RUNE-side wicks are conservative boundary-derived estimates.${volumeNote}`;
  }

  if (sourceKind === 'pool-candle' && targetKind === 'pool-candle') {
    return `THORChain pool ratio is the source of truth. The current candle is rebuilt from live pool ratio, and historical cross-pair wicks are conservative boundary-derived estimates.${volumeNote}`;
  }

  return `THORChain pool ratio is the source of truth. The current candle is rebuilt from live pool ratio, and historical candles are derived from THORChain-native pricing.${volumeNote}`;
}

export class ThorchainChartDataProvider {
  constructor() {
    this.cache = new Map();
  }

  clearCache() {
    this.cache.clear();
  }

  getCachedSeries(cacheKey) {
    const cached = this.cache.get(cacheKey);
    if (!cached) return null;

    if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
      this.cache.delete(cacheKey);
      return null;
    }

    return cached.value;
  }

  setCachedSeries(cacheKey, value) {
    this.cache.set(cacheKey, {
      value,
      timestamp: Date.now()
    });
  }

  async getAssetHistory(asset, rangeKey, options = {}) {
    const { force = false } = options;
    const config = getRangeConfig(rangeKey);
    const cacheKey = `${asset}:${config.key}`;
    const cached = force ? null : this.getCachedSeries(cacheKey);

    if (cached) return cached;

    const normalizedAsset = normalizeAsset(asset);
    let result;

    if (normalizedAsset === 'THOR.RUNE') {
      const data = await midgard.getRuneHistory(
        { interval: config.interval, count: String(config.count) },
        { cache: false }
      );

      result = {
        kind: 'rune-candle',
        candles: enforceContinuousCandles(normalizeRuneHistory(data, config.durationMs))
      };
    } else {
      const data = await midgard.getPoolHistory(
        asset,
        { interval: config.interval, count: String(config.count) },
        { cache: false }
      );

      result = {
        kind: 'pool-candle',
        candles: enforceContinuousCandles(normalizePoolHistory(data, config.durationMs))
      };
    }

    this.setCachedSeries(cacheKey, result);
    return result;
  }

  async getPoolSwapHistory(pool, rangeKey, options = {}) {
    const { force = false } = options;
    const config = getRangeConfig(rangeKey);
    const cacheKey = `swap:${normalizeAsset(pool)}:${config.key}`;
    const cached = force ? null : this.getCachedSeries(cacheKey);

    if (cached) return cached;

    const data = await midgard.getSwapHistory(
      {
        pool,
        interval: config.interval,
        count: String(config.count)
      },
      { cache: false }
    );

    const result = {
      kind: 'swap-volume',
      candles: normalizeSwapHistory(data, config.durationMs)
    };

    this.setCachedSeries(cacheKey, result);
    return result;
  }

  async getPairSeries(pair, rangeKey = '7D', options = {}) {
    if (!pair?.sourceAsset || !pair?.targetAsset) {
      return {
        range: getRangeConfig(rangeKey),
        candles: [],
        note: 'Select a market to load THORChain price history.',
        kind: 'unavailable'
      };
    }

    const volumePools = getVolumePools(pair);
    const [sourceHistory, targetHistory, volumeHistories] = await Promise.all([
      this.getAssetHistory(pair.sourceAsset, rangeKey, options),
      this.getAssetHistory(pair.targetAsset, rangeKey, options),
      Promise.all(
        volumePools.map((pool) =>
          this.getPoolSwapHistory(pool, rangeKey, options).catch(() => ({
            kind: 'swap-volume',
            candles: []
          }))
        )
      )
    ]);

    const range = getRangeConfig(rangeKey);
    const priceCandles = dropInProgressCandles(
      alignPairCandles(sourceHistory.candles, targetHistory.candles),
      range.durationMs
    );
    const combinedVolumeSeries = scaleVolumeSeries(
      combineVolumeSeries(volumeHistories.map((history) => history.candles)),
      volumePools.length > 1 ? 0.5 : 1
    );
    const { closedSeries: closedVolumeSeries, activeItem: activeVolumeItem } = splitSeriesByActiveBucket(
      combinedVolumeSeries,
      range.durationMs
    );
    const volumeByTime = new Map(closedVolumeSeries.map((item) => [item.time, item.volume]));
    const candles = priceCandles.map((candle) => ({
      ...candle,
      volume: volumeByTime.get(candle.time) ?? 0
    }));
    const latest = candles.at(-1) ?? null;
    const previous = candles.length > 1 ? candles.at(candles.length - 2) : null;
    const first = candles[0] ?? null;

    return {
      range,
      candles,
      latest,
      previous,
      first,
      activeVolume: activeVolumeItem?.volume ?? 0,
      kind: 'native-candles',
      sourceKind: sourceHistory.kind,
      targetKind: targetHistory.kind,
      note: buildSeriesNote(pair, sourceHistory.kind, targetHistory.kind, volumePools.length)
    };
  }
}

export const thorchainChartDataProvider = new ThorchainChartDataProvider();
