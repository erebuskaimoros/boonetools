export const POL_TRACKER_RANGES = Object.freeze([
  { id: '30d', label: '30D', days: 30 },
  { id: '90d', label: '90D', days: 90 },
  { id: '180d', label: '180D', days: 180 },
  { id: 'all', label: 'ALL TIME', days: null }
]);

export const POL_TRACKER_SERIES = Object.freeze([
  { id: 'synth', label: 'SYNTH BACKING', group: 'overview', color: '#5588cc', value: (row) => row?.synthBackingUsd ?? null },
  { id: 'treasury_total', label: 'TREASURY LOCKED LP', group: 'overview', color: '#d4a017', value: (row) => row?.treasuryTotalUsd ?? null },
  { id: 'reserve_pol', label: 'RESERVE POL', group: 'overview', color: '#00cc66', value: (row) => row?.reservePolUsd ?? null }
]);

export const POL_TRACKER_GROUPS = Object.freeze([
  {
    id: 'overview',
    title: 'Daily tracked values',
    description: 'Three same-height values stacked as shaded areas from each completed UTC day end.'
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
    treasuryTotalUsd: finite(row.treasury_lp?.total_usd),
    reservePolRune: finite(row.reserve_pol?.deployed_rune),
    reservePolUsd: finite(row.reserve_pol?.deployed_usd),
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
      treasuryTotalUsd: finite(pool.treasury_total_usd),
      reservePolRune: finite(pool.reserve_pol_rune),
      reservePolUsd: finite(pool.reserve_pol_usd)
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

export function projectPolTrackerChartSelection(options = {}) {
  const count = Math.max(0, Math.trunc(Number(options.rowCount)) || 0);
  const left = Number(options.plotLeft);
  const right = Number(options.plotRight);
  const first = Number(options.startX);
  const last = Number(options.endX);
  if (count < 2 || ![left, right, first, last].every(Number.isFinite) || right <= left) return null;

  const clamp = (value) => Math.max(left, Math.min(right, value));
  const selectionLeft = Math.min(clamp(first), clamp(last));
  const selectionRight = Math.max(clamp(first), clamp(last));
  if (selectionRight - selectionLeft < Math.max(0, Number(options.minDrag ?? 12) || 0)) return null;

  const span = right - left;
  const startIndex = Math.round(((selectionLeft - left) / span) * (count - 1));
  const endIndex = Math.round(((selectionRight - left) / span) * (count - 1));
  if (endIndex <= startIndex) return null;
  return { startIndex, endIndex };
}

function niceCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export function totalPolTrackerValue(row) {
  const values = POL_TRACKER_SERIES.map((series) => series.value(row));
  if (!values.every((value) => Number.isFinite(value))) return null;
  return values.reduce((total, value) => total + value, 0);
}

function buildStackPaths(points, y) {
  const segments = [];
  let segment = [];
  for (const point of points) {
    if (point) {
      segment.push(point);
    } else if (segment.length) {
      segments.push(segment);
      segment = [];
    }
  }
  if (segment.length) segments.push(segment);

  return {
    path: segments.map((pointsInSegment) => pointsInSegment
      .map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${y(point.upper).toFixed(2)}`)
      .join(' ')).join(' '),
    areaPath: segments.map((pointsInSegment) => {
      const upper = pointsInSegment
        .map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${y(point.upper).toFixed(2)}`)
        .join(' ');
      const lower = [...pointsInSegment].reverse()
        .map((point) => `L${point.x.toFixed(2)},${y(point.lower).toFixed(2)}`)
        .join(' ');
      return `${upper} ${lower} Z`;
    }).join(' ')
  };
}

export function buildPolTrackerChart(rows = [], groupId, options = {}) {
  const width = options.width || 1000;
  const height = options.height || 260;
  const plot = { left: 82, right: width - 16, top: 14, bottom: height - 32 };
  const series = POL_TRACKER_SERIES.filter((item) => item.group === groupId);
  const spanX = plot.right - plot.left;
  const x = (index) => plot.left + (rows.length <= 1 ? 0 : (index / (rows.length - 1)) * spanX);
  const cumulative = rows.map(() => 0);
  const stackAvailable = rows.map(() => true);
  const pointSets = series.map((item) => rows.map((row, index) => {
    const value = item.value(row);
    if (!stackAvailable[index] || !Number.isFinite(value) || value < 0) {
      stackAvailable[index] = false;
      return null;
    }
    const lower = cumulative[index];
    cumulative[index] += value;
    return { x: x(index), lower, upper: cumulative[index] };
  }));
  const yMax = niceCeiling(Math.max(1, ...cumulative));
  const spanY = plot.bottom - plot.top;
  const y = (value) => plot.bottom - (Math.max(0, value) / yMax) * spanY;
  const paths = series.map((item, index) => ({
    ...item,
    ...buildStackPaths(pointSets[index], y)
  }));
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
    || (pool.reservePolUsd || 0) > 0
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
