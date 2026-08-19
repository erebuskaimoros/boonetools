import { config } from '../lib/config.js';
import { getReadModel } from './read-models.js';
import {
  POL_TRACKER_SCHEMA_VERSION,
  POL_TRACKER_START_DATE,
  e8ToNumber
} from '../../../shared/pol-tracker/model.js';
import {
  loadLatestPolTrackerPools,
  loadPolTrackerStoredDays
} from './pol-tracker-store.js';

export const POL_TRACKER_MODEL_KEY = 'pol-tracker:v2';
export const POL_TRACKER_TTL_MS = 36 * 60 * 60 * 1000;
export { POL_TRACKER_SCHEMA_VERSION };

const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_LANES = Object.freeze([
  'synth',
  'treasury',
  'reserve_pol'
]);

function dateString(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
}

function dayRange(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];
  const days = [];
  for (let cursor = start; cursor <= end; cursor += DAY_MS) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

function resolveNow(value) {
  const resolved = typeof value === 'function' ? value() : value;
  const parsed = resolved instanceof Date ? resolved : new Date(resolved || Date.now());
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

export function lastCompletedUtcDay(now = new Date()) {
  const parsed = now instanceof Date ? now : new Date(now);
  const midnight = Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
  return new Date(midnight - DAY_MS).toISOString().slice(0, 10);
}

function publicLaneStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(PUBLIC_LANES
    .filter((key) => value[key] && typeof value[key] === 'object')
    .map((key) => [key, value[key]]));
}

function publicLaneWarnings(status) {
  return [...new Set(Object.values(status)
    .map((lane) => String(lane?.warning || '').trim())
    .filter(Boolean))];
}

function publicRowComplete(row, status) {
  if (!PUBLIC_LANES.every((key) => status[key])) return Boolean(row.complete);
  return PUBLIC_LANES.every((key) => status[key].status === 'complete');
}

function publicDailyRow(row, day) {
  if (!row) {
    return {
      day,
      height: null,
      block_time: null,
      rune_price_usd: null,
      synth: { backing_usd: null, face_usd: null },
      treasury_lp: { total_usd: null },
      reserve_pol: { deployed_rune: null, deployed_usd: null },
      complete: false,
      status: { state: 'missing' },
      warnings: ['No completed same-height observation is stored for this UTC day']
    };
  }
  const status = publicLaneStatus(row.lane_status);
  return {
    day,
    height: Number(row.anchor_height) || null,
    block_time: row.anchor_block_time ? new Date(row.anchor_block_time).toISOString() : null,
    rune_price_usd: e8ToNumber(row.rune_price_usd_e8),
    synth: {
      backing_usd: e8ToNumber(row.synth_backing_usd_e8),
      face_usd: e8ToNumber(row.synth_face_usd_e8)
    },
    treasury_lp: {
      total_usd: e8ToNumber(row.treasury_total_usd_e8)
    },
    reserve_pol: {
      deployed_rune: e8ToNumber(row.reserve_pol_rune_e8),
      deployed_usd: e8ToNumber(row.reserve_pol_usd_e8)
    },
    complete: publicRowComplete(row, status),
    status,
    warnings: publicLaneWarnings(status)
  };
}

function publicPoolRow(row) {
  return {
    day: dateString(row.day),
    asset: String(row.asset || ''),
    status: String(row.pool_status || ''),
    asset_price_usd: e8ToNumber(row.asset_price_usd_e8),
    synth_units: String(row.synth_units || '0'),
    synth_supply: e8ToNumber(row.synth_supply_e8),
    synth_backing_usd: e8ToNumber(row.synth_backing_usd_e8),
    synth_face_usd: e8ToNumber(row.synth_face_usd_e8),
    treasury_lp_units: String(row.treasury_lp_units || '0'),
    treasury_total_usd: e8ToNumber(row.treasury_total_usd_e8)
  };
}

export function buildPolTrackerPayload(rows = [], poolRows = [], options = {}) {
  const now = resolveNow(options.now);
  const startDate = options.startDate || config.polTrackerStartDate || POL_TRACKER_START_DATE;
  const endDate = options.endDate || lastCompletedUtcDay(now);
  const rowsByDay = new Map(rows.map((row) => [dateString(row.day), row]));
  const daily = dayRange(startDate, endDate).map((day) => publicDailyRow(rowsByDay.get(day), day));
  const observed = daily.filter((row) => row.height !== null);
  const completeDays = observed.filter((row) => row.complete).length;
  const partialDays = observed.length - completeDays;
  const missingDays = daily.length - observed.length;
  const latest = observed.at(-1) || null;
  const warnings = [...new Set(observed.flatMap((row) => row.warnings || []))];

  return {
    schema_version: POL_TRACKER_SCHEMA_VERSION,
    as_of: latest?.block_time || now.toISOString(),
    start_date: startDate,
    end_date: endDate,
    coverage: {
      expected_days: daily.length,
      observed_days: observed.length,
      complete_days: completeDays,
      partial_days: partialDays,
      missing_days: missingDays,
      first_day: observed[0]?.day || null,
      last_day: latest?.day || null
    },
    latest,
    daily,
    latest_pools: poolRows.map(publicPoolRow),
    warnings,
    methodology: {
      sampling: 'Latest finalized THORChain block at or before 23:59:59.999 UTC for each completed day.',
      pricing: 'Same-height THORNode TOR prices; all stored source amounts use 1e8 fixed-point units.',
      treasury: 'Combined same-height redeemable value of locked Treasury module LP positions.',
      synth: 'Synth-unit share of pool liquidity, valued as 2 × asset depth × synth_units / pool_units.',
      reserve_pol: 'Gross value of LP positions held at the legacy Reserve module, from runepool.pol.value.',
      runepool_ownership_excluded: true,
      aggregation: 'The tooltip total is the arithmetic sum of synth backing, Treasury locked LP, and Reserve POL.'
    }
  };
}

export async function buildPolTrackerReadModel(client, options = {}) {
  const startDate = options.startDate || config.polTrackerStartDate || POL_TRACKER_START_DATE;
  const now = resolveNow(options.now);
  const endDate = options.endDate || lastCompletedUtcDay(now);
  const [rows, pools] = await Promise.all([
    (options.loadDays || loadPolTrackerStoredDays)(client, startDate, endDate),
    (options.loadPools || loadLatestPolTrackerPools)(client)
  ]);
  const payload = buildPolTrackerPayload(rows, pools, { ...options, now, startDate, endDate });
  return {
    payload,
    generatedAt: now.toISOString(),
    sourceUpdatedAt: payload.latest?.block_time || null,
    metadata: { coverage: payload.coverage },
    stats: { ...payload.coverage, latest_pools: payload.latest_pools.length }
  };
}

export async function getPolTrackerReadModel(options = {}) {
  return getReadModel(POL_TRACKER_MODEL_KEY, { ...options, allowStale: options.allowStale !== false });
}
