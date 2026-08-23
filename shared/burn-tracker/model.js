export const BURN_TRACKER_SCHEMA_VERSION = 1;
export const BURN_TRACKER_START_DATE = '2024-09-26';
export const SYSTEM_INCOME_BURN_MIMIR = 'SYSTEMINCOMEBURNRATEBPS';
export const SYSTEM_INCOME_BURN_CONSTANT = 'SystemIncomeBurnRateBps';

const INTEGER = /^\d+$/;

export function nonNegativeIntegerString(value, fallback = null) {
  const normalized = String(value ?? '').trim();
  return INTEGER.test(normalized) ? BigInt(normalized).toString() : fallback;
}

function decimalString(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? String(value) : null;
}

function dateFromUnixSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function normalizedPoolName(pool = {}) {
  return String(pool.pool || pool.asset || '').trim().toLowerCase();
}

export function incomeBurnPool(aggregate = {}) {
  return (Array.isArray(aggregate?.pools) ? aggregate.pools : [])
    .find((pool) => normalizedPoolName(pool) === 'income_burn') || null;
}

export function incomeBurnBase(aggregate = {}, fallback = '0') {
  const pool = incomeBurnPool(aggregate);
  if (!pool) return fallback;
  return nonNegativeIntegerString(pool.earnings ?? pool.rewards, fallback);
}

export function parseBurnTrackerInterval(interval = {}, options = {}) {
  const day = options.day || dateFromUnixSeconds(interval.startTime ?? interval.start_time);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('Midgard earnings interval did not contain a valid UTC start day');
  }
  return {
    day,
    burn_e8: incomeBurnBase(interval, '0'),
    rune_price_usd: decimalString(interval.runePriceUSD ?? interval.rune_price_usd),
    interval_start: interval.startTime == null
      ? `${day}T00:00:00.000Z`
      : new Date(Number(interval.startTime) * 1000).toISOString(),
    interval_end: interval.endTime == null
      ? null
      : new Date(Number(interval.endTime) * 1000).toISOString(),
    partial: Boolean(options.partial),
    source: options.source || 'liquify-midgard-earnings',
    source_json: interval
  };
}

function caseInsensitiveValue(object, key) {
  const match = Object.entries(object && typeof object === 'object' ? object : {})
    .find(([candidate]) => candidate.toUpperCase() === key.toUpperCase());
  return match?.[1];
}

export function resolveSystemIncomeBurnRate(mimir = {}, constants = {}) {
  const override = Number(caseInsensitiveValue(mimir, SYSTEM_INCOME_BURN_MIMIR));
  const fallback = Number(caseInsensitiveValue(constants?.int_64_values, SYSTEM_INCOME_BURN_CONSTANT));
  const bps = Number.isInteger(override) && override >= 0
    ? override
    : Number.isInteger(fallback) && fallback >= 0
      ? fallback
      : null;
  return {
    bps,
    percent: bps === null ? null : bps / 100,
    source: Number.isInteger(override) && override >= 0 ? 'mimir' : bps === null ? 'unavailable' : 'constant'
  };
}

export function bankRuneSupplyBase(payload = {}) {
  const amount = payload?.amount?.amount ?? payload?.supply?.amount;
  return nonNegativeIntegerString(amount, null);
}

export function runningBurnTotals(rows = []) {
  let total = 0n;
  let complete = true;
  return rows.map((row) => {
    const burn = nonNegativeIntegerString(row?.burn_e8, null);
    if (burn === null) complete = false;
    if (burn !== null) total += BigInt(burn);
    return {
      ...row,
      cumulative_burn_e8: complete ? total.toString() : null
    };
  });
}

function addBaseUnits(left, right) {
  return (BigInt(nonNegativeIntegerString(left, '0'))
    + BigInt(nonNegativeIntegerString(right, '0'))).toString();
}

function subtractBaseUnits(left, right) {
  const result = BigInt(nonNegativeIntegerString(left, '0'))
    - BigInt(nonNegativeIntegerString(right, '0'));
  return (result < 0n ? 0n : result).toString();
}

function liveDay(value) {
  const normalized = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function latestIso(...values) {
  const timestamps = values
    .map((value) => Date.parse(String(value || '')))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

/**
 * Overlay exact post-snapshot THORChain reward-event burns on the durable
 * Midgard daily read model. The caller is responsible for supplying only
 * blocks newer than the snapshot so amounts are never counted twice.
 */
export function applyBurnTrackerLiveOverlay(payload = {}, overlay = {}) {
  const increments = new Map();
  for (const row of Array.isArray(overlay.days) ? overlay.days : []) {
    const day = liveDay(row?.day);
    const burn = nonNegativeIntegerString(row?.burn_e8, null);
    if (day && burn !== null) increments.set(day, addBaseUnits(increments.get(day), burn));
  }

  let incrementTotal = 0n;
  const rowsByDay = new Map(
    (Array.isArray(payload.daily) ? payload.daily : [])
      .filter((row) => liveDay(row?.day))
      .map((row) => [liveDay(row.day), { ...row, day: liveDay(row.day) }])
  );
  for (const [day, burn] of increments) {
    incrementTotal += BigInt(burn);
    const existing = rowsByDay.get(day) || {
      day,
      burn_e8: '0',
      cumulative_burn_e8: null,
      rune_price_usd: null
    };
    rowsByDay.set(day, {
      ...existing,
      burn_e8: addBaseUnits(existing.burn_e8, burn),
      partial: true,
      source: 'liquify-ws-rewards-live'
    });
  }

  const daily = runningBurnTotals(
    [...rowsByDay.values()].sort((left, right) => left.day.localeCompare(right.day))
  );
  const delta = incrementTotal.toString();
  const throughHeight = Math.max(0, Math.trunc(Number(overlay.through_height)) || 0);
  const throughTime = latestIso(payload.as_of, overlay.through_time);
  const lastDay = daily.at(-1)?.day || payload.coverage?.end_day || '';

  return {
    ...payload,
    as_of: throughTime || payload.as_of || null,
    summary: {
      ...(payload.summary || {}),
      total_burned_e8: addBaseUnits(payload.summary?.total_burned_e8, delta),
      current_supply_e8: payload.summary?.current_supply_e8 == null
        ? null
        : subtractBaseUnits(payload.summary.current_supply_e8, delta)
    },
    daily,
    coverage: {
      ...(payload.coverage || {}),
      ...(lastDay ? { end_day: lastDay } : {})
    },
    sources: {
      ...(payload.sources || {}),
      live_burns: 'liquify-ws:rewards.income_burn'
    },
    live: {
      per_block: true,
      through_height: throughHeight,
      through_time: throughTime,
      overlay_burn_e8: delta
    }
  };
}
