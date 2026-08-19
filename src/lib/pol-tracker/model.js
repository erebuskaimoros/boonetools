export const POL_TRACKER_RANGES = Object.freeze([
  { id: '30d', label: '30D', days: 30 },
  { id: '90d', label: '90D', days: 90 },
  { id: '1y', label: '1Y', days: 365 },
  { id: 'all', label: 'ALL', days: null }
]);

export const POL_TRACKER_SERIES = Object.freeze([
  { id: 'synth', label: 'SYNTH BACKING', group: 'liabilities', color: '#5588cc', value: (row) => row?.synthBackingUsd ?? null },
  { id: 'treasury_asset', label: 'ASSET LEG', group: 'treasury', color: '#d4a017', value: (row) => row?.treasuryAssetUsd ?? null },
  { id: 'treasury_rune', label: 'RUNE LEG', group: 'treasury', color: '#00cc66', value: (row) => row?.treasuryRuneUsd ?? null },
  { id: 'treasury_total', label: 'LOCKED TOTAL', group: 'treasury', color: '#e8e8e8', value: (row) => row?.treasuryTotalUsd ?? null },
  { id: 'reserve_pol', label: 'RESERVE POL', group: 'protocol', color: '#5588cc', value: (row) => row?.reservePolUsd ?? null },
  { id: 'runepool_reserve', label: 'RUNEPOOL RESERVE SHARE', group: 'protocol', color: '#00cc66', value: (row) => row?.runepoolReserveUsd ?? null }
]);

export const POL_TRACKER_GROUPS = Object.freeze([
  {
    id: 'liabilities',
    title: 'Synth backing',
    description: 'Pool liquidity allocated to outstanding synth units at each completed UTC day end.'
  },
  {
    id: 'treasury',
    title: 'Locked Treasury module LP',
    description: 'Same-height redeemable asset and RUNE legs, with their combined position value.'
  },
  {
    id: 'protocol',
    title: 'Reserve POL / RUNEPool',
    description: 'Gross legacy Reserve LP value versus the Reserve-owned RUNEPool share. Provider ownership is excluded.'
  }
]);

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function day(value) {
  const normalized = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

export function normalizePolTrackerDailyRow(row = {}) {
  return {
    day: day(row.day),
    height: finite(row.height),
    blockTime: row.block_time || null,
    runePriceUsd: finite(row.rune_price_usd),
    synthBackingUsd: finite(row.synth?.backing_usd),
    synthFaceUsd: finite(row.synth?.face_usd),
    treasuryAssetUsd: finite(row.treasury_lp?.asset_leg_usd),
    treasuryRuneUsd: finite(row.treasury_lp?.rune_leg_usd),
    treasuryTotalUsd: finite(row.treasury_lp?.total_usd),
    reservePolRune: finite(row.reserve_pol?.deployed_rune),
    reservePolUsd: finite(row.reserve_pol?.deployed_usd),
    runepoolReserveRune: finite(row.runepool?.reserve_owned_rune),
    runepoolReserveUsd: finite(row.runepool?.reserve_owned_usd),
    complete: Boolean(row.complete),
    status: row.status && typeof row.status === 'object' ? row.status : {},
    warnings: Array.isArray(row.warnings) ? row.warnings : []
  };
}

export function normalizePolTrackerPayload(payload = {}) {
  const daily = (Array.isArray(payload.daily) ? payload.daily : [])
    .map(normalizePolTrackerDailyRow)
    .filter((row) => row.day)
    .sort((left, right) => left.day.localeCompare(right.day));
  return {
    asOf: payload.as_of || null,
    startDate: day(payload.start_date),
    endDate: day(payload.end_date),
    stale: Boolean(payload.stale),
    coverage: payload.coverage || {},
    daily,
    latest: daily.filter((row) => row.height !== null).at(-1) || null,
    latestPools: (Array.isArray(payload.latest_pools) ? payload.latest_pools : []).map((pool) => ({
      day: day(pool.day),
      asset: String(pool.asset || ''),
      status: String(pool.status || ''),
      assetPriceUsd: finite(pool.asset_price_usd),
      synthUnits: String(pool.synth_units || '0'),
      synthSupply: finite(pool.synth_supply),
      synthBackingUsd: finite(pool.synth_backing_usd),
      synthFaceUsd: finite(pool.synth_face_usd),
      treasuryLpUnits: String(pool.treasury_lp_units || '0'),
      treasuryAssetRedeem: finite(pool.treasury_asset_redeem),
      treasuryRuneRedeem: finite(pool.treasury_rune_redeem),
      treasuryAssetUsd: finite(pool.treasury_asset_usd),
      treasuryRuneUsd: finite(pool.treasury_rune_usd),
      treasuryTotalUsd: finite(pool.treasury_total_usd)
    })),
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    methodology: payload.methodology || {}
  };
}

export function selectPolTrackerRange(rows = [], rangeId = 'all') {
  const ordered = Array.isArray(rows) ? rows : [];
  const range = POL_TRACKER_RANGES.find((candidate) => candidate.id === rangeId)
    || POL_TRACKER_RANGES.at(-1);
  if (!range.days || ordered.length <= range.days) return ordered;
  return ordered.slice(-range.days);
}

function niceCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export function buildPolTrackerChart(rows = [], groupId, options = {}) {
  const width = options.width || 1000;
  const height = options.height || 260;
  const plot = { left: 82, right: width - 16, top: 14, bottom: height - 32 };
  const hidden = new Set(options.hiddenSeries || []);
  const series = POL_TRACKER_SERIES.filter((item) => item.group === groupId && !hidden.has(item.id));
  const values = rows.flatMap((row) => series.map((item) => item.value(row)))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const yMax = niceCeiling(Math.max(1, ...values));
  const spanX = plot.right - plot.left;
  const spanY = plot.bottom - plot.top;
  const x = (index) => plot.left + (rows.length <= 1 ? 0 : (index / (rows.length - 1)) * spanX);
  const y = (value) => plot.bottom - (Math.max(0, value) / yMax) * spanY;
  const paths = series.map((item) => {
    let path = '';
    let penDown = false;
    rows.forEach((row, index) => {
      const value = item.value(row);
      if (!Number.isFinite(value)) {
        penDown = false;
        return;
      }
      path += `${penDown ? ' L' : 'M'}${x(index).toFixed(2)},${y(value).toFixed(2)}`;
      penDown = true;
    });
    return { ...item, path };
  });
  const tickIndexes = [...new Set(Array.from({ length: Math.min(5, rows.length) }, (_, index) =>
    Math.round((index / Math.max(1, Math.min(5, rows.length) - 1)) * Math.max(0, rows.length - 1))
  ))];
  return {
    width,
    height,
    plot,
    yMax,
    paths,
    yTicks: Array.from({ length: 5 }, (_, index) => ({
      value: yMax * (index / 4),
      y: y(yMax * (index / 4))
    })),
    xTicks: tickIndexes.map((index) => ({ index, x: x(index), day: rows[index]?.day || '' })),
    x
  };
}

export function relevantPolTrackerPools(pools = []) {
  return (Array.isArray(pools) ? pools : []).filter((pool) =>
    (pool.synthBackingUsd || 0) > 0
    || (pool.treasuryTotalUsd || 0) > 0
  );
}

export function formatPolTrackerUsd(value, compact = false) {
  const number = finite(value);
  if (number === null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 2 : 0
  }).format(number);
}

export function formatPolTrackerRune(value) {
  const number = finite(value);
  if (number === null) return '—';
  return `${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(number)} RUNE`;
}
