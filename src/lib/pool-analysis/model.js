export const POOL_ANALYSIS_RANGES = Object.freeze([
  { id: '30d', label: '30D' },
  { id: 'all', label: 'ALL TIME' }
]);

export const POOL_ANALYSIS_LINE_METRICS = Object.freeze([
  { id: 'depth', label: 'DEPTH', field: 'depthUsd' },
  { id: 'cumulativeFees', label: 'CUMULATIVE FEES', field: 'cumulativeFeesUsd' }
]);

export function poolAnalysisLineMetric(id) {
  return POOL_ANALYSIS_LINE_METRICS.find((metric) => metric.id === id)
    || POOL_ANALYSIS_LINE_METRICS[1];
}

export const POOL_ANALYSIS_TABLE_PERIODS = Object.freeze([
  { id: '24h', label: '24H', days: 1 },
  { id: '7d', label: '7D', days: 7 },
  { id: '30d', label: '30D', days: 30 },
  { id: '90d', label: '90D', days: 90 },
  { id: '1y', label: '1Y', days: 365 }
]);

export function poolAnalysisPeriodDescription(metadata = {}, periodId = '30d') {
  const period = POOL_ANALYSIS_TABLE_PERIODS.find((candidate) => candidate.id === periodId)
    || POOL_ANALYSIS_TABLE_PERIODS[2];
  const rolling = period.id === '24h' ? 'the preceding 24 hours' : `the preceding ${period.days} days`;
  const daily = period.id === '24h' ? 'the latest completed UTC day' : `${period.days} completed UTC days`;
  if (metadata.mode === 'rolling') return rolling;
  if (metadata.mode === 'bucketed') {
    return `${rolling} as 15-minute history becomes available; until then, ${daily}`;
  }
  return daily;
}

export function poolAnalysisWindowLabel(pool = {}, metadata = {}) {
  if (metadata.mode === 'bucketed') {
    return pool.windowMode === 'rolling' && pool.snapshotReady
      ? `ROLLING · ${Math.round((pool.snapshotResolutionSeconds || 900) / 60)}M`
      : 'DAILY · BUILDING HISTORY';
  }
  return metadata.mode === 'rolling' ? 'ROLLING' : 'DAILY';
}

export const POOL_ANALYSIS_COLUMNS = Object.freeze([
  { id: 'asset', label: 'POOL', defaultDirection: 'asc' },
  { id: 'priceUsd', label: 'USD PRICE', defaultDirection: 'desc' },
  { id: 'oraclePriceUsd', label: 'ORACLE', defaultDirection: 'desc' },
  { id: 'depthUsd', label: 'DEPTH', defaultDirection: 'desc' },
  { id: 'balanceRuneBase', label: 'BALANCES', defaultDirection: 'desc' },
  { id: 'periodVolumeUsd', label: 'VOLUME', defaultDirection: 'desc' },
  { id: 'periodFeesUsd', label: 'FEES', defaultDirection: 'desc' },
  { id: 'volumeDepthPercent', label: 'VOLUME / DEPTH', defaultDirection: 'desc' },
  { id: 'feeDepthPercent', label: 'FEES / DEPTH', defaultDirection: 'desc' },
  { id: 'feeVolumePercent', label: 'FEES / VOLUME', defaultDirection: 'desc' },
  { id: 'annualizedFeeRatePercent', label: 'EST APR', defaultDirection: 'desc' }
]);

export function poolAnalysisColumns(_periodId = '30d') {
  return POOL_ANALYSIS_COLUMNS;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function baseString(value) {
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

function date(value) {
  const normalized = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function normalizeCoverage(value = {}, expectedDays = 0) {
  return {
    firstDay: date(value.first_day),
    lastDay: date(value.last_day),
    observedDays: Math.max(0, Number(value.observed_days) || 0),
    expectedDays: Math.max(0, Number(value.expected_days) || expectedDays),
    missingDays: Math.max(0, Number(value.missing_days) || 0)
  };
}

function baseRatioPercent(numerator, denominator, multiplier = 100) {
  const top = baseString(numerator);
  const bottom = baseString(denominator);
  if (top === null || bottom === null || Number(bottom) <= 0) return null;
  return (Number(top) / Number(bottom)) * multiplier;
}

export function poolAnalysisFeeVolumeBps(feesBase, volumeBase) {
  return baseRatioPercent(feesBase, volumeBase, 10_000);
}

function normalizePeriodMetric(value = {}, period, volumeDepthScale = 1, balanceRuneBase = null) {
  const volumeDepthPercent = finite(value.volume_depth_percent);
  const periodFeesBase = baseString(value.fees_rune_e8);
  const feeDepthPercent = finite(value.fee_depth_percent);
  return {
    id: period.id,
    days: period.days,
    windowMode: value.window_mode || null,
    snapshotReady: Boolean(value.snapshot_ready),
    snapshotResolutionSeconds: finite(value.snapshot_resolution_seconds),
    windowStart: value.window_start || null,
    windowEnd: value.window_end || null,
    periodStale: Boolean(value.stale),
    periodIncomplete: Boolean(value.incomplete),
    usdFeeEstimate: Boolean(value.usd_fee_estimate),
    periodVolumeBase: baseString(value.volume_rune_e8),
    periodVolumeUsd: finite(value.volume_usd),
    periodFeesBase,
    periodFeesUsd: finite(value.fees_usd),
    feeDepthPercent: feeDepthPercent ?? baseRatioPercent(periodFeesBase, balanceRuneBase, 50),
    feeVolumePercent: finite(value.fee_volume_percent),
    volumeDepthPercent: volumeDepthPercent === null ? null : volumeDepthPercent * volumeDepthScale,
    annualizedFeesRune: finite(value.annualized_fees_rune),
    annualizedFeesUsd: finite(value.annualized_fees_usd),
    annualizedFeeRatePercent: finite(value.annualized_fee_rate_percent),
    coverage: normalizeCoverage(value.coverage, period.days)
  };
}

export function selectPoolAnalysisPeriod(pool = {}, periodId = '30d') {
  const period = POOL_ANALYSIS_TABLE_PERIODS.find((candidate) => candidate.id === periodId)
    || POOL_ANALYSIS_TABLE_PERIODS.find((candidate) => candidate.id === '30d');
  const metrics = pool.periodMetrics?.[period.id] || normalizePeriodMetric({}, period);
  return { ...pool, ...metrics, selectedPeriodId: period.id, selectedPeriodDays: period.days };
}

export function baseToNumber(value) {
  const base = baseString(value);
  return base === null ? null : Number(base) / 1e8;
}

export function normalizePoolAnalysisSummary(payload = {}) {
  const pools = (Array.isArray(payload.pools) ? payload.pools : []).map((pool) => {
    const oneSidedDepthUsd = finite(pool.depth_usd);
    const totalDepthUsd = finite(pool.total_depth_usd);
    const balanceRuneBase = baseString(pool.balance_rune_e8);
    const volumeDepthScale = totalDepthUsd === null ? 0.5 : 1;
    const legacy30d = {
      volume_rune_e8: pool.period_volume_rune_e8,
      volume_usd: pool.period_volume_usd,
      fees_rune_e8: pool.period_fees_rune_e8,
      fees_usd: pool.period_fees_usd,
      fee_depth_percent: pool.fee_depth_percent,
      fee_volume_percent: pool.fee_volume_percent,
      volume_depth_percent: pool.volume_depth_percent,
      annualized_fees_rune: pool.annualized_fees_rune,
      annualized_fees_usd: pool.annualized_fees_usd,
      annualized_fee_rate_percent: pool.annualized_fee_rate_percent,
      coverage: pool.coverage
    };
    const periodMetrics = Object.fromEntries(POOL_ANALYSIS_TABLE_PERIODS.map((period) => [
      period.id,
      normalizePeriodMetric(
        pool.period_metrics?.[period.id] || (period.id === '30d' ? legacy30d : {}),
        period,
        volumeDepthScale,
        balanceRuneBase
      )
    ]));
    return selectPoolAnalysisPeriod({
      asset: String(pool.asset || '').toUpperCase(),
      chain: String(pool.chain || '').toUpperCase(),
      symbol: String(pool.symbol || '').toUpperCase(),
      status: String(pool.status || ''),
      tradingHalted: Boolean(pool.trading_halted),
      priceUsd: finite(pool.price_usd),
      oracleSymbol: pool.oracle_symbol || null,
      oraclePriceUsd: finite(pool.oracle_price_usd),
      oracleDeviationPercent: finite(pool.oracle_deviation_percent),
      depthUsd: totalDepthUsd ?? (oneSidedDepthUsd === null ? null : oneSidedDepthUsd * 2),
      balanceAssetBase: baseString(pool.balance_asset_e8),
      balanceRuneBase,
      periodMetrics
    }, '30d');
  }).filter((pool) => pool.asset);
  return {
    asOf: payload.as_of || null,
    stale: Boolean(payload.stale),
    period: payload.period && typeof payload.period === 'object' ? payload.period : {},
    runePriceUsd: finite(payload.rune_price_usd),
    pools,
    sources: payload.sources && typeof payload.sources === 'object' ? payload.sources : {},
    warnings: Array.isArray(payload.warnings) ? payload.warnings : []
  };
}

function sortValue(pool, column) {
  if (column === 'asset') return pool.asset;
  return pool[column] ?? null;
}

export function sortPoolAnalysisRows(rows = [], sort = {}) {
  const column = POOL_ANALYSIS_COLUMNS.find((candidate) => candidate.id === sort.column)
    || POOL_ANALYSIS_COLUMNS.find((candidate) => candidate.id === 'depthUsd');
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue = sortValue(left, column.id);
    const rightValue = sortValue(right, column.id);
    const leftMissing = leftValue === null || leftValue === undefined || leftValue === '';
    const rightMissing = rightValue === null || rightValue === undefined || rightValue === '';
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    if (!leftMissing && leftValue !== rightValue) {
      return typeof leftValue === 'string'
        ? leftValue.localeCompare(rightValue) * direction
        : (Number(leftValue) - Number(rightValue)) * direction;
    }
    return left.asset.localeCompare(right.asset);
  });
}

export function filterPoolAnalysisRows(rows = [], options = {}) {
  const query = String(options.search || '').trim().toUpperCase();
  const status = String(options.status || 'available').toLowerCase();
  return rows.filter((pool) => {
    const matchesQuery = !query || `${pool.asset} ${pool.symbol} ${pool.chain}`.includes(query);
    const poolStatus = pool.status.toLowerCase();
    const matchesStatus = status === 'all' || poolStatus === status;
    return matchesQuery && matchesStatus;
  });
}

export function normalizePoolAnalysisSeries(payload = {}) {
  return {
    asset: String(payload.asset || '').toUpperCase(),
    symbol: String(payload.symbol || '').toUpperCase(),
    range: payload.range === 'all' ? 'all' : '30d',
    asOf: payload.as_of || null,
    stale: Boolean(payload.stale),
    points: (Array.isArray(payload.points) ? payload.points : []).map((row) => ({
      day: date(row.day),
      volumeRuneBase: baseString(row.volume_rune_e8),
      volumeRune: baseToNumber(row.volume_rune_e8),
      volumeUsd: finite(row.volume_usd),
      feesRuneBase: baseString(row.fees_rune_e8),
      feesRune: baseToNumber(row.fees_rune_e8),
      feesUsd: finite(row.fees_usd),
      cumulativeFeesRuneBase: baseString(row.cumulative_fees_rune_e8),
      cumulativeFeesRune: baseToNumber(row.cumulative_fees_rune_e8),
      cumulativeFeesUsd: finite(row.cumulative_fees_usd),
      depthUsd: finite(row.depth_usd),
      depthPartial: Boolean(row.depth_partial),
      depthUpdatedAt: row.depth_updated_at || null,
      runePriceUsd: finite(row.rune_price_usd),
      partial: Boolean(row.partial),
      source: String(row.source || '')
    })).filter((row) => row.day),
    coverage: {
      firstIndexedDay: date(payload.coverage?.first_indexed_day),
      firstDisplayedDay: date(payload.coverage?.first_displayed_day),
      lastDay: date(payload.coverage?.last_day),
      observedDays: Math.max(0, Number(payload.coverage?.observed_days) || 0),
      missingDays: Array.isArray(payload.coverage?.missing_days) ? payload.coverage.missing_days : [],
      depthMissingDays: Array.isArray(payload.coverage?.depth_missing_days) ? payload.coverage.depth_missing_days : []
    },
    warnings: Array.isArray(payload.warnings) ? payload.warnings : []
  };
}

export function formatPoolAnalysisUsd(value, options = {}) {
  const numeric = finite(value);
  if (numeric === null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: options.compact ? 'compact' : 'standard',
    maximumFractionDigits: options.compact ? 2 : numeric >= 1 ? 2 : 5
  }).format(numeric);
}

export function formatPoolAnalysisNumber(value, options = {}) {
  const numeric = finite(value);
  if (numeric === null) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: options.compact ? 'compact' : 'standard',
    maximumFractionDigits: options.maximumFractionDigits ?? 2
  }).format(numeric);
}

export function formatPoolAnalysisPercent(value) {
  const numeric = finite(value);
  return numeric === null ? '—' : `${numeric.toFixed(Math.abs(numeric) < 1 ? 2 : 1)}%`;
}
