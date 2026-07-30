const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const SAMPLE_MINUTES = 5;
const SAMPLE_COUNT = (7 * 24 * 60 / SAMPLE_MINUTES) + 1;
const PREVIEW_END_MS = Date.UTC(2026, 6, 29, 12, 0, 0);

export const POOL_DISLOCATION_CHART_WINDOWS = Object.freeze([
  { id: '1h', label: '1H', durationMs: HOUR_MS },
  { id: '1d', label: '1D', durationMs: 24 * HOUR_MS },
  { id: '7d', label: '7D', durationMs: 7 * 24 * HOUR_MS }
]);

export const POOL_DISLOCATION_ROLLING_WINDOWS = Object.freeze([
  { id: '1h', label: '1H', durationMs: HOUR_MS },
  { id: '6h', label: '6H', durationMs: 6 * HOUR_MS },
  { id: '1d', label: '1D', durationMs: 24 * HOUR_MS }
]);

export const DISLOCATION_WINDOWS = Object.freeze([
  { id: '1h', label: '1H', durationMs: HOUR_MS },
  { id: '4h', label: '4H', durationMs: 4 * HOUR_MS },
  { id: '1d', label: '1D', durationMs: 24 * HOUR_MS },
  { id: '3d', label: '3D', durationMs: 3 * 24 * HOUR_MS },
  { id: '7d', label: '7D', durationMs: 7 * 24 * HOUR_MS }
]);

export const POOL_DISLOCATION_TABLE_COLUMNS = Object.freeze([
  { id: 'pool', label: 'POOL', defaultDirection: 'asc' },
  { id: 'pool_price', label: 'TC PRICE', defaultDirection: 'desc' },
  { id: 'oracle', label: 'VS ORACLE', defaultDirection: 'desc' },
  { id: 'binance', label: 'VS BINANCE', defaultDirection: 'desc' },
  ...DISLOCATION_WINDOWS.map((window) => ({
    id: `abs_${window.id}`,
    label: `${window.label} ABS`,
    defaultDirection: 'desc'
  })),
  { id: 'peak', label: '7D PEAK', defaultDirection: 'desc' },
  { id: 'time', label: 'TIME > LIMIT', defaultDirection: 'desc' },
  { id: 'trend', label: 'TREND / ABS', defaultDirection: 'desc' },
  { id: 'state', label: 'STATE', defaultDirection: 'desc' }
]);

const PREVIEW_POOLS = Object.freeze([
  { asset: 'BTC.BTC', symbol: 'BTC', chain: 'BTC', basePrice: 63_700, bias: 0.18, amplitude: 0.42, phase: 0.2, spike: 0.35 },
  { asset: 'ETH.ETH', symbol: 'ETH', chain: 'ETH', basePrice: 1_892, bias: 0.58, amplitude: 0.72, phase: 1.1, spike: 0.85 },
  { asset: 'SOL.SOL', symbol: 'SOL', chain: 'SOL', basePrice: 73.15, bias: -0.72, amplitude: 1.08, phase: 2.2, spike: -1.15 },
  { asset: 'DOGE.DOGE', symbol: 'DOGE', chain: 'DOGE', basePrice: 0.0701, bias: 0.94, amplitude: 1.42, phase: 0.6, spike: 1.55 },
  { asset: 'BSC.BNB', symbol: 'BNB', chain: 'BSC', basePrice: 568.03, bias: 0.24, amplitude: 0.48, phase: 2.8, spike: 0.45 },
  { asset: 'AVAX.AVAX', symbol: 'AVAX', chain: 'AVAX', basePrice: 6.38, bias: -0.38, amplitude: 0.92, phase: 1.7, spike: -0.75 },
  { asset: 'BCH.BCH', symbol: 'BCH', chain: 'BCH', basePrice: 210.42, bias: 0.48, amplitude: 0.76, phase: 0.9, spike: 0.62 },
  { asset: 'LTC.LTC', symbol: 'LTC', chain: 'LTC', basePrice: 45.16, bias: -0.27, amplitude: 0.62, phase: 2.4, spike: -0.52 },
  { asset: 'GAIA.ATOM', symbol: 'ATOM', chain: 'GAIA', basePrice: 1.27, bias: -0.84, amplitude: 1.12, phase: 1.4, spike: -1.18 },
  { asset: 'XRP.XRP', symbol: 'XRP', chain: 'XRP', basePrice: 1.068, bias: 0.62, amplitude: 0.86, phase: 0.1, spike: 0.92 },
  { asset: 'TRX.TRX', symbol: 'TRX', chain: 'TRX', basePrice: 0.3262, bias: 0.12, amplitude: 0.34, phase: 1.9, spike: 0.28 },
  { asset: 'ZEC.ZEC', symbol: 'ZEC', chain: 'ZEC', basePrice: 462.57, bias: 1.34, amplitude: 1.68, phase: 2.6, spike: 2.1 }
]);

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function computeDislocationPercent(poolPrice, referencePrice) {
  const pool = finiteNumber(poolPrice);
  const reference = finiteNumber(referencePrice);
  if (pool === null || reference === null || pool <= 0 || reference <= 0) return null;
  return ((pool / reference) - 1) * 100;
}

function previewPoint(config, index) {
  const cycle = index / (SAMPLE_COUNT - 1);
  const marketMove = (Math.sin(cycle * Math.PI * 2 + config.phase) * 0.026)
    + (Math.cos(cycle * Math.PI * 3.4 + config.phase / 2) * 0.009)
    + ((cycle - 0.5) * 0.018);
  const oraclePrice = config.basePrice * (1 + marketMove);
  const binanceBasisPercent = (Math.sin(cycle * Math.PI * 12 + config.phase) * 0.09) - 0.02;
  const binancePrice = oraclePrice * (1 + binanceBasisPercent / 100);
  const spikeDistance = Math.abs(cycle - 0.72);
  const spike = config.spike * Math.max(0, 1 - spikeDistance / 0.04);
  const oracleDislocation = config.bias
    + (Math.sin(cycle * Math.PI * 8 + config.phase) * config.amplitude)
    + (Math.cos(cycle * Math.PI * 17 + config.phase) * config.amplitude * 0.22)
    + spike;
  const poolPrice = oraclePrice * (1 + oracleDislocation / 100);

  return {
    observedAt: new Date(PREVIEW_END_MS - ((SAMPLE_COUNT - 1 - index) * SAMPLE_MINUTES * MINUTE_MS)).toISOString(),
    poolPrice,
    oraclePrice,
    binancePrice,
    oracleDislocation: computeDislocationPercent(poolPrice, oraclePrice),
    binanceDislocation: computeDislocationPercent(poolPrice, binancePrice)
  };
}

export function buildPoolDislocationPreview() {
  return PREVIEW_POOLS.map((config) => ({
    asset: config.asset,
    symbol: config.symbol,
    chain: config.chain,
    oracleSymbol: config.symbol,
    binanceSymbol: `${config.symbol}USDT`,
    points: Array.from({ length: SAMPLE_COUNT }, (_, index) => previewPoint(config, index))
  }));
}

export function maxAbsoluteDislocation(point) {
  const values = [point?.oracleDislocation, point?.binanceDislocation]
    .map(finiteNumber)
    .filter((value) => value !== null);
  return values.length ? Math.max(...values.map(Math.abs)) : null;
}

export function buildPoolDislocationChartViewport(points = [], options = {}) {
  const orderedPoints = [...(Array.isArray(points) ? points : [])]
    .filter((point) => Number.isFinite(Date.parse(point?.observedAt || '')))
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const requestedDurationMs = Math.max(
    SAMPLE_MINUTES * MINUTE_MS,
    finiteNumber(options.durationMs) ?? POOL_DISLOCATION_CHART_WINDOWS.at(-1).durationMs
  );
  const requestedEndMs = Date.parse(options.endAt || '');
  const fallbackEndMs = Date.parse(orderedPoints.at(-1)?.observedAt || '');
  const baseEndMs = Number.isFinite(requestedEndMs)
    ? requestedEndMs
    : Number.isFinite(fallbackEndMs) ? fallbackEndMs : Date.now();
  const baseStartMs = baseEndMs - requestedDurationMs;
  const requestedZoomStartMs = finiteNumber(options.zoomStartMs);
  const requestedZoomEndMs = finiteNumber(options.zoomEndMs);
  const hasZoom = requestedZoomStartMs !== null
    && requestedZoomEndMs !== null
    && requestedZoomEndMs - requestedZoomStartMs >= SAMPLE_MINUTES * MINUTE_MS;
  const startMs = hasZoom
    ? Math.max(baseStartMs, Math.min(requestedZoomStartMs, baseEndMs - SAMPLE_MINUTES * MINUTE_MS))
    : baseStartMs;
  const endMs = hasZoom
    ? Math.min(baseEndMs, Math.max(requestedZoomEndMs, startMs + SAMPLE_MINUTES * MINUTE_MS))
    : baseEndMs;
  const visiblePoints = orderedPoints.filter((point) => {
    const observedMs = Date.parse(point.observedAt);
    return observedMs >= startMs && observedMs <= endMs;
  });

  return {
    startMs,
    endMs,
    durationMs: endMs - startMs,
    expectedSamples: Math.floor((endMs - startMs) / (SAMPLE_MINUTES * MINUTE_MS)) + 1,
    zoomed: hasZoom,
    points: visiblePoints
  };
}

export function buildPoolDislocationRollingAverage(points = [], field, options = {}) {
  const sampleIntervalMs = Math.max(
    MINUTE_MS,
    finiteNumber(options.sampleIntervalMs) ?? SAMPLE_MINUTES * MINUTE_MS
  );
  const durationMs = Math.max(
    sampleIntervalMs,
    finiteNumber(options.durationMs) ?? HOUR_MS
  );
  const expectedSamples = Math.floor(durationMs / sampleIntervalMs) + 1;
  const orderedPoints = [...(Array.isArray(points) ? points : [])]
    .filter((point) => Number.isFinite(Date.parse(point?.observedAt || '')))
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));

  return orderedPoints.map((point, index) => {
    const windowPoints = orderedPoints.slice(Math.max(0, index - expectedSamples + 1), index + 1);
    const windowStartMs = Date.parse(point.observedAt) - durationMs;
    let total = 0;
    let complete = windowPoints.length === expectedSamples
      && Date.parse(windowPoints[0]?.observedAt || '') === windowStartMs;

    for (let windowIndex = 0; complete && windowIndex < windowPoints.length; windowIndex += 1) {
      const value = finiteNumber(windowPoints[windowIndex]?.[field]);
      const timestamp = Date.parse(windowPoints[windowIndex]?.observedAt || '');
      const previousTimestamp = windowIndex > 0
        ? Date.parse(windowPoints[windowIndex - 1]?.observedAt || '')
        : null;
      if (value === null || (previousTimestamp !== null && timestamp - previousTimestamp !== sampleIntervalMs)) {
        complete = false;
      } else {
        total += value;
      }
    }

    return {
      observedAt: point.observedAt,
      rollingAverage: complete ? total / expectedSamples : null
    };
  });
}

export function buildPoolDislocationLinePath(points = [], field, options = {}) {
  const projectX = typeof options.projectX === 'function'
    ? options.projectX
    : (_point, index) => index;
  const projectY = typeof options.projectY === 'function'
    ? options.projectY
    : (value) => value;
  const maximumGapMs = finiteNumber(options.maximumGapMs) ?? Number.POSITIVE_INFINITY;
  let path = '';
  let previousTimestamp = null;
  let penDown = false;

  for (const [index, point] of (Array.isArray(points) ? points : []).entries()) {
    const value = finiteNumber(point?.[field]);
    const timestamp = Date.parse(point?.observedAt || '');
    if (value === null || !Number.isFinite(timestamp)) {
      penDown = false;
      previousTimestamp = timestamp;
      continue;
    }
    if (previousTimestamp !== null && timestamp - previousTimestamp > maximumGapMs) penDown = false;

    const x = finiteNumber(projectX(point, index));
    const y = finiteNumber(projectY(value, point, index));
    if (x === null || y === null) {
      penDown = false;
      previousTimestamp = timestamp;
      continue;
    }

    path += `${penDown ? ' L' : path ? ' M' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    penDown = true;
    previousTimestamp = timestamp;
  }

  return path;
}

export function buildPoolDislocationChartScale(points = [], options = {}) {
  const sourceMode = ['oracle', 'binance'].includes(options.sourceMode)
    ? options.sourceMode
    : 'both';
  const threshold = Math.abs(finiteNumber(options.threshold) ?? 1);
  const values = [];

  for (const point of Array.isArray(points) ? points : []) {
    if (sourceMode !== 'binance') {
      const value = finiteNumber(point?.oracleDislocation);
      if (value !== null) values.push(value);
    }
    if (sourceMode !== 'oracle') {
      const value = finiteNumber(point?.binanceDislocation);
      if (value !== null) values.push(value);
    }
  }

  if (values.length === 0) values.push(-threshold, threshold);
  else values.push(0);
  let dataMin = Math.min(...values);
  let dataMax = Math.max(...values);
  if (dataMax === dataMin) {
    const minimumSpan = Math.max(0.1, Math.abs(dataMax) * 0.08);
    const midpoint = (dataMin + dataMax) / 2;
    dataMin = midpoint - (minimumSpan / 2);
    dataMax = midpoint + (minimumSpan / 2);
  }
  const padding = Math.max((dataMax - dataMin) * 0.04, 0.0025);
  const min = dataMin === 0 && dataMax > 0 ? 0 : dataMin - padding;
  const max = dataMax === 0 && dataMin < 0 ? 0 : dataMax + padding;
  const step = (max - min) / 6;
  const ticks = Array.from({ length: 7 }, (_, index) => {
    const value = max - (step * index);
    return Math.abs(value) < step / 1_000_000 ? 0 : Number(value.toPrecision(12));
  });
  if (min < 0 && max > 0 && !ticks.some((value) => value === 0)) {
    ticks.push(0);
    ticks.sort((left, right) => right - left);
  }

  return { min, max, step, ticks };
}

export function projectPoolDislocationChartSelection(options = {}) {
  const plotLeft = finiteNumber(options.plotLeft);
  const plotRight = finiteNumber(options.plotRight);
  const startX = finiteNumber(options.startX);
  const endX = finiteNumber(options.endX);
  const viewportStartMs = finiteNumber(options.viewportStartMs);
  const viewportEndMs = finiteNumber(options.viewportEndMs);
  const minimumPixels = Math.max(1, finiteNumber(options.minimumPixels) ?? 8);
  if ([plotLeft, plotRight, startX, endX, viewportStartMs, viewportEndMs].some((value) => value === null)) {
    return null;
  }
  if (plotRight <= plotLeft || viewportEndMs <= viewportStartMs || Math.abs(endX - startX) < minimumPixels) {
    return null;
  }
  const clampX = (value) => Math.min(plotRight, Math.max(plotLeft, value));
  const leftX = Math.min(clampX(startX), clampX(endX));
  const rightX = Math.max(clampX(startX), clampX(endX));
  const durationMs = viewportEndMs - viewportStartMs;
  const projectedStartMs = viewportStartMs + (((leftX - plotLeft) / (plotRight - plotLeft)) * durationMs);
  const projectedEndMs = viewportStartMs + (((rightX - plotLeft) / (plotRight - plotLeft)) * durationMs);
  if (projectedEndMs - projectedStartMs < SAMPLE_MINUTES * MINUTE_MS) return null;
  return { startMs: projectedStartMs, endMs: projectedEndMs };
}

export function summarizePool(pool, threshold = 1) {
  const points = Array.isArray(pool?.points) ? pool.points : [];
  const current = points.at(-1) || null;
  const magnitudes = points
    .map(maxAbsoluteDislocation)
    .filter((value) => value !== null);
  const averageAbsolute = magnitudes.length
    ? magnitudes.reduce((sum, value) => sum + value, 0) / magnitudes.length
    : null;
  const peakAbsolute = magnitudes.length ? Math.max(...magnitudes) : null;
  const samplesOutsideThreshold = magnitudes.filter((value) => value >= threshold).length;
  const latestTimestamp = Date.parse(current?.observedAt || '');
  const averageAbsoluteByWindow = Object.fromEntries(DISLOCATION_WINDOWS.map((window) => {
    const windowMagnitudes = Number.isFinite(latestTimestamp)
      ? points
        .filter((point) => {
          const timestamp = Date.parse(point?.observedAt || '');
          return Number.isFinite(timestamp) && timestamp >= latestTimestamp - window.durationMs;
        })
        .map(maxAbsoluteDislocation)
        .filter((value) => value !== null)
      : magnitudes;
    const average = windowMagnitudes.length
      ? windowMagnitudes.reduce((sum, value) => sum + value, 0) / windowMagnitudes.length
      : null;
    return [window.id, average];
  }));

  return {
    ...pool,
    current,
    currentAbsolute: maxAbsoluteDislocation(current),
    averageAbsolute,
    averageAbsoluteByWindow,
    peakAbsolute,
    samplesOutsideThreshold,
    hoursOutsideThreshold: samplesOutsideThreshold * SAMPLE_MINUTES / 60
  };
}

export function summarizePoolDislocation(pools = [], threshold = 1) {
  const poolSummaries = pools
    .map((pool) => summarizePool(pool, threshold))
    .sort((left, right) => (right.currentAbsolute ?? -1) - (left.currentAbsolute ?? -1));
  const currentLeader = poolSummaries[0] || null;
  const peakLeader = [...poolSummaries]
    .sort((left, right) => (right.peakAbsolute ?? -1) - (left.peakAbsolute ?? -1))[0] || null;

  return {
    pools: poolSummaries,
    threshold,
    coveredPools: poolSummaries.filter((pool) => pool.current?.oraclePrice && pool.current?.binancePrice).length,
    totalPools: poolSummaries.length,
    outsideThreshold: poolSummaries.filter((pool) => (pool.currentAbsolute ?? 0) >= threshold).length,
    currentLeader,
    peakLeader
  };
}

export function dislocationState(value, threshold = 1) {
  if (value === null || value === undefined || value === '') return 'missing';
  const magnitude = Math.abs(Number(value));
  if (!Number.isFinite(magnitude)) return 'missing';
  if (magnitude >= Math.max(2.5, threshold * 2.5)) return 'critical';
  if (magnitude >= threshold) return 'watch';
  return 'normal';
}

function poolDislocationSortValue(pool, columnId, threshold) {
  if (columnId === 'pool') return `${pool?.symbol || ''} ${pool?.asset || ''}`.trim().toUpperCase();
  if (columnId === 'pool_price') return finiteNumber(pool?.current?.poolPrice);
  if (columnId === 'oracle') return finiteNumber(pool?.current?.oracleDislocation);
  if (columnId === 'binance') return finiteNumber(pool?.current?.binanceDislocation);
  if (columnId.startsWith('abs_')) {
    return finiteNumber(pool?.averageAbsoluteByWindow?.[columnId.slice(4)]);
  }
  if (columnId === 'peak') return finiteNumber(pool?.peakAbsolute);
  if (columnId === 'time') return finiteNumber(pool?.hoursOutsideThreshold);
  if (columnId === 'trend') return finiteNumber(pool?.currentAbsolute);
  if (columnId === 'state') {
    if (finiteNumber(pool?.currentAbsolute) === null) return null;
    return { missing: 0, normal: 1, watch: 2, critical: 3 }[
      dislocationState(pool?.currentAbsolute, threshold)
    ];
  }
  return finiteNumber(pool?.currentAbsolute);
}

export function sortPoolDislocationPools(pools = [], options = {}) {
  const column = POOL_DISLOCATION_TABLE_COLUMNS.find(({ id }) => id === options.column)
    || POOL_DISLOCATION_TABLE_COLUMNS.find(({ id }) => id === 'trend');
  const direction = options.direction === 'asc' || options.direction === 'desc'
    ? options.direction
    : column.defaultDirection;
  const multiplier = direction === 'asc' ? 1 : -1;
  const threshold = finiteNumber(options.threshold) ?? 1;

  return [...(Array.isArray(pools) ? pools : [])].sort((left, right) => {
    const leftValue = poolDislocationSortValue(left, column.id, threshold);
    const rightValue = poolDislocationSortValue(right, column.id, threshold);
    const leftMissing = leftValue === null || leftValue === undefined || leftValue === '';
    const rightMissing = rightValue === null || rightValue === undefined || rightValue === '';
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;

    let comparison = 0;
    if (typeof leftValue === 'string' || typeof rightValue === 'string') {
      comparison = String(leftValue).localeCompare(String(rightValue));
    } else {
      comparison = Number(leftValue) - Number(rightValue);
    }
    if (comparison !== 0) return comparison * multiplier;
    return String(left?.asset || '').localeCompare(String(right?.asset || ''));
  });
}

function normalizePoint(point = {}) {
  const poolPrice = finiteNumber(point.pool_price_usd ?? point.poolPrice);
  const oraclePrice = finiteNumber(point.oracle_price_usd ?? point.oraclePrice);
  const binancePrice = finiteNumber(point.binance_price_usd ?? point.binancePrice);
  return {
    observedAt: point.observed_at ?? point.observedAt ?? null,
    poolPrice,
    oraclePrice,
    binancePrice,
    oracleDislocation: finiteNumber(point.oracle_dislocation ?? point.oracleDislocation)
      ?? computeDislocationPercent(poolPrice, oraclePrice),
    binanceDislocation: finiteNumber(point.binance_dislocation ?? point.binanceDislocation)
      ?? computeDislocationPercent(poolPrice, binancePrice),
    sampleOrigin: String(point.sample_origin ?? point.sampleOrigin ?? 'scheduled'),
    thorchainHeight: finiteNumber(point.thorchain_height ?? point.thorchainHeight),
    poolPriceMethod: point.pool_price_method ?? point.poolPriceMethod ?? null,
    oraclePriceMethod: point.oracle_price_method ?? point.oraclePriceMethod ?? null,
    binancePriceMethod: point.binance_price_method ?? point.binancePriceMethod ?? null
  };
}

export function normalizePoolDislocationSummary(payload = {}) {
  const pools = (Array.isArray(payload?.pools) ? payload.pools : []).map((pool) => ({
    asset: String(pool?.asset || ''),
    symbol: String(pool?.symbol || ''),
    chain: String(pool?.chain || ''),
    status: String(pool?.status || ''),
    tradingHalted: pool?.trading_halted === true,
    tradingStatusKnown: pool?.trading_status_known === true,
    oracleSymbol: pool?.oracle_symbol || null,
    binanceSymbol: pool?.binance_symbol || null,
    current: normalizePoint(pool?.latest),
    currentAbsolute: maxAbsoluteDislocation(normalizePoint(pool?.latest)),
    averageAbsoluteByWindow: Object.fromEntries(DISLOCATION_WINDOWS.map((window) => [
      window.id,
      finiteNumber(pool?.average_abs?.[window.id])
    ])),
    peakAbsolute: finiteNumber(pool?.peak_abs_7d),
    hoursOutsideByThreshold: Object.fromEntries(Object.entries(pool?.time_outside_hours || {}).map(
      ([key, value]) => [String(key), finiteNumber(value) ?? 0]
    )),
    samples: pool?.samples || { total: 0, oracle: 0, binance: 0 },
    sparkline: (Array.isArray(pool?.sparkline) ? pool.sparkline : []).map(normalizePoint)
  }));

  return {
    ...payload,
    pools,
    coverage: {
      totalPools: Number(payload?.coverage?.total_pools || pools.length),
      oracleMapped: Number(payload?.coverage?.oracle_mapped || 0),
      binanceMapped: Number(payload?.coverage?.binance_mapped || 0),
      fullyMapped: Number(payload?.coverage?.fully_mapped || 0),
      fullyObserved: Number(payload?.coverage?.fully_observed || 0)
    },
    chainTrading: {
      knownChains: Array.isArray(payload?.chain_trading?.known_chains)
        ? payload.chain_trading.known_chains.map(String)
        : [],
      haltedChains: Array.isArray(payload?.chain_trading?.halted_chains)
        ? payload.chain_trading.halted_chains.map(String)
        : []
    }
  };
}

export function buildPoolDislocationDashboard(summary = {}, threshold = 1) {
  const poolSummaries = (summary?.pools || [])
    .map((pool) => ({
      ...pool,
      hoursOutsideThreshold: pool.hoursOutsideByThreshold?.[String(threshold)] ?? 0
    }))
    .sort((left, right) => (right.currentAbsolute ?? -1) - (left.currentAbsolute ?? -1));
  const currentLeader = poolSummaries.find((pool) => pool.currentAbsolute !== null) || null;
  const peakLeader = [...poolSummaries]
    .sort((left, right) => (right.peakAbsolute ?? -1) - (left.peakAbsolute ?? -1))
    .find((pool) => pool.peakAbsolute !== null) || null;

  return {
    pools: poolSummaries,
    coveredPools: summary?.coverage?.fullyObserved ?? 0,
    mappedPools: summary?.coverage?.fullyMapped ?? 0,
    totalPools: summary?.coverage?.totalPools ?? poolSummaries.length,
    outsideThreshold: poolSummaries.filter((pool) => (pool.currentAbsolute ?? -1) >= threshold).length,
    currentLeader,
    peakLeader
  };
}

export function filterPoolDislocationDashboardByTrading(dashboard = {}, excludeHalted = true) {
  const allPools = Array.isArray(dashboard?.pools) ? dashboard.pools : [];
  const pools = excludeHalted
    ? allPools.filter((pool) => !pool.tradingHalted)
    : allPools;
  const currentLeader = pools.find((pool) => pool.currentAbsolute !== null) || null;
  const peakLeader = [...pools]
    .sort((left, right) => (right.peakAbsolute ?? -1) - (left.peakAbsolute ?? -1))
    .find((pool) => pool.peakAbsolute !== null) || null;
  const haltedChains = [...new Set(allPools
    .filter((pool) => pool.tradingHalted)
    .map((pool) => pool.chain)
    .filter(Boolean))].sort();

  return {
    ...dashboard,
    pools,
    coveredPools: pools.filter((pool) => (
      finiteNumber(pool.current?.oraclePrice) !== null
      && finiteNumber(pool.current?.binancePrice) !== null
    )).length,
    mappedPools: pools.filter((pool) => pool.oracleSymbol && pool.binanceSymbol).length,
    totalPools: pools.length,
    availablePools: allPools.length,
    hiddenHaltedPools: excludeHalted ? allPools.length - pools.length : 0,
    haltedChains,
    outsideThreshold: pools.filter((pool) => (
      (pool.currentAbsolute ?? -1) >= (dashboard?.threshold ?? 1)
    )).length,
    currentLeader,
    peakLeader
  };
}

export function normalizePoolDislocationSeries(payload = {}) {
  const provenance = payload?.provenance || {};
  return {
    ...payload,
    asset: String(payload?.asset || ''),
    symbol: String(payload?.symbol || ''),
    chain: String(payload?.chain || ''),
    oracleSymbol: payload?.oracle_symbol || null,
    binanceSymbol: payload?.binance_symbol || null,
    provenance: {
      scheduledSamples: Number(provenance.scheduled_samples || 0),
      backfilledSamples: Number(provenance.backfilled_samples || 0),
      poolPriceMethods: Array.isArray(provenance.pool_price_methods) ? provenance.pool_price_methods.map(String) : [],
      oraclePriceMethods: Array.isArray(provenance.oracle_price_methods) ? provenance.oracle_price_methods.map(String) : [],
      binancePriceMethods: Array.isArray(provenance.binance_price_methods) ? provenance.binance_price_methods.map(String) : []
    },
    points: (Array.isArray(payload?.points) ? payload.points : []).map(normalizePoint)
  };
}
