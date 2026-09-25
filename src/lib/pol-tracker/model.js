export const POL_TRACKER_RANGES = Object.freeze([
  { id: '30d', label: '30D', days: 30 },
  { id: '90d', label: '90D', days: 90 },
  { id: '180d', label: '180D', days: 180 },
  { id: 'all', label: 'ALL TIME', days: null }
]);

export const POL_TRACKER_SERIES = Object.freeze([
  { id: 'synth', label: 'SYNTH BACKING', group: 'overview', color: '#5588cc', value: (row) => row?.synthBackingUsd ?? null },
  { id: 'treasury_total', label: 'TREASURY LOCKED LP', group: 'overview', color: '#d4a017', value: (row) => row?.treasuryTotalUsd ?? null },
  { id: 'reserve_pol', label: 'RESERVE POL', group: 'overview', color: '#00cc66', value: (row) => row?.reservePolUsd ?? null },
  { id: 'system_income_pol', label: 'SYSTEM INCOME POL', group: 'overview', color: '#ff8a3d', value: (row) => row?.systemIncomePolUsd ?? null }
]);

export const POL_TRACKER_GROUPS = Object.freeze([
  {
    id: 'overview',
    title: 'Daily tracked values',
    description: 'Four same-height values stacked as shaded areas from each completed UTC day end.'
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
    systemIncomePolRune: finite(row.system_income_pol?.position_rune),
    systemIncomePolUsd: finite(row.system_income_pol?.position_usd),
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
  const currentSystemIncomePol = payload.current?.system_income_pol;
  return {
    asOf: payload.as_of || null,
    startDate: day(payload.start_date),
    endDate: day(payload.end_date),
    stale: Boolean(payload.stale),
    coverage: payload.coverage || {},
    daily,
    latest: daily.filter((row) => row.height !== null).at(-1) || null,
    currentSystemIncomePol: currentSystemIncomePol && typeof currentSystemIncomePol === 'object'
      ? {
          asOf: currentSystemIncomePol.as_of || null,
          positionRune: finite(currentSystemIncomePol.position_rune),
          positionUsd: finite(currentSystemIncomePol.position_usd),
          runeLegUsd: finite(currentSystemIncomePol.rune_leg_usd),
          assetLegUsd: finite(currentSystemIncomePol.asset_leg_usd)
        }
      : null,
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
      reservePolUsd: finite(pool.reserve_pol_usd),
      systemIncomePolRune: finite(pool.system_income_pol_rune),
      systemIncomePolUsd: finite(pool.system_income_pol_usd)
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

export function totalPolTrackerValue(row) {
  const values = POL_TRACKER_SERIES.map((series) => series.value(row));
  if (!values.every((value) => Number.isFinite(value))) return null;
  return values.reduce((total, value) => total + value, 0);
}

// Same-height stock composition, not cumulative totals over time. A missing
// lower valuation invalidates every layer above it; zero contributes nothing
// but does not invalidate upper layers. Null zero layers also avoid drawing an
// outline over the holdings below them.
export function polTrackerStackValues(rows = []) {
  const available = rows.map(() => true);
  return POL_TRACKER_SERIES.map(item => rows.map((row, index) => {
    const value = item.value(row);
    if (!available[index] || !Number.isFinite(value) || value < 0) {
      available[index] = false;
      return null;
    }
    return value === 0 ? null : value;
  }));
}

export function relevantPolTrackerPools(pools = []) {
  return (Array.isArray(pools) ? pools : []).filter((pool) =>
    (pool.synthBackingUsd || 0) > 0
    || (pool.treasuryTotalUsd || 0) > 0
    || (pool.reservePolUsd || 0) > 0
    || (pool.systemIncomePolUsd || 0) > 0
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
