import { getReadModel } from './read-models.js';
import { getThorNodeCoreSnapshot, coreSnapshotValue } from './thornode-core-snapshot.js';
import {
  BURN_TRACKER_SCHEMA_VERSION,
  BURN_TRACKER_START_DATE,
  bankRuneSupplyBase,
  nonNegativeIntegerString,
  resolveSystemIncomeBurnRate,
  runningBurnTotals
} from '../../../shared/burn-tracker/model.js';
import {
  getBurnTrackerSyncState,
  loadBurnTrackerCoverage,
  loadBurnTrackerDays
} from './burn-tracker-store.js';

export const BURN_TRACKER_MODEL_KEY = 'system-income-burn:v1';
export const BURN_TRACKER_TTL_MS = 15 * 60 * 1000;
export { BURN_TRACKER_SCHEMA_VERSION };

const DAY_MS = 24 * 60 * 60 * 1000;

function dayString(value) {
  const normalized = String(value || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
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

function sourceTime(...values) {
  const timestamps = values.map((value) => Date.parse(value || '')).filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

export async function buildBurnTrackerReadModel(client, options = {}) {
  const nowValue = typeof options.now === 'function' ? options.now() : options.now;
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
  const endDate = now.toISOString().slice(0, 10);
  const startDate = options.startDate || BURN_TRACKER_START_DATE;
  const [stored, coverage, sync, core] = await Promise.all([
    (options.loadDays || loadBurnTrackerDays)(client, startDate, endDate),
    (options.loadCoverage || loadBurnTrackerCoverage)(client),
    (options.getSyncState || getBurnTrackerSyncState)(client),
    (options.getCoreSnapshot || getThorNodeCoreSnapshot)({ client, allowStale: true })
  ]);
  const storedByDay = new Map(stored.map((row) => [dayString(row.day), row]));
  const materialized = dayRange(startDate, endDate).map((day) => {
    const row = storedByDay.get(day);
    return row ? {
      day,
      burn_e8: nonNegativeIntegerString(row.burn_e8, null),
      rune_price_usd: row.rune_price_usd == null ? null : String(row.rune_price_usd),
      partial: Boolean(row.partial),
      source: String(row.source || '')
    } : {
      day,
      burn_e8: null,
      rune_price_usd: null,
      partial: false,
      source: 'missing'
    };
  });
  const daily = runningBurnTotals(materialized);
  const fallbackTotal = daily.reduce(
    (total, row) => total + BigInt(nonNegativeIntegerString(row.burn_e8, '0')),
    0n
  ).toString();
  const allTimeTotal = nonNegativeIntegerString(sync?.stats_json?.all_time_burn_e8, fallbackTotal);
  const mimir = coreSnapshotValue(core, 'mimir', {});
  const constants = coreSnapshotValue(core, 'constants', {});
  const supplyPayload = coreSnapshotValue(core, 'rune_supply', {});
  const rate = resolveSystemIncomeBurnRate(mimir, constants);
  const supply = bankRuneSupplyBase(supplyPayload);
  const missingDays = daily.filter((row) => row.burn_e8 === null).map((row) => row.day);
  const reconciliationDelta = BigInt(allTimeTotal) - BigInt(fallbackTotal);
  const absoluteReconciliationDelta = reconciliationDelta < 0n
    ? -reconciliationDelta
    : reconciliationDelta;
  const displayTotal = missingDays.length ? allTimeTotal : fallbackTotal;
  const warnings = [];
  if (missingDays.length) warnings.push(`${missingDays.length} UTC burn day(s) are missing`);
  if (absoluteReconciliationDelta > 100_000_000n) {
    warnings.push('Stored daily burn sum does not yet reconcile to the Midgard all-time total');
  }
  if (rate.bps === null) warnings.push('Current system-income burn rate is unavailable');
  if (supply === null) warnings.push('Current bank RUNE supply is unavailable');
  if (sync?.last_error) warnings.push(`Burn ingestion: ${sync.last_error}`);

  const generatedAt = now.toISOString();
  const sourceUpdatedAt = sourceTime(
    coverage?.source_updated_at,
    core?.sourceUpdatedAt,
    core?.payload?.source_updated_at,
    sync?.updated_at
  );
  return {
    payload: {
      schema_version: BURN_TRACKER_SCHEMA_VERSION,
      as_of: generatedAt,
      summary: {
        total_burned_e8: displayTotal,
        current_supply_e8: supply,
        burn_rate_bps: rate.bps,
        burn_rate_percent: rate.percent
      },
      daily,
      coverage: {
        start_day: startDate,
        end_day: endDate,
        observed_days: Number(coverage?.observed_days) || stored.length,
        expected_days: daily.length,
        missing_days: missingDays,
        last_completed_day: dayString(sync?.last_completed_day)
      },
      sources: {
        burns: 'liquify-midgard-earnings:income_burn',
        rune_price: 'liquify-midgard-earnings:runePriceUSD',
        supply: 'thornode-core:rune_supply',
        burn_rate: `thornode-core:${rate.source}`
      },
      warnings
    },
    generatedAt,
    sourceUpdatedAt,
    metadata: { warnings, partial: warnings.length > 0 },
    stats: { rows: daily.length, missing_days: missingDays.length }
  };
}

export async function getBurnTrackerReadModel(options = {}) {
  return getReadModel(BURN_TRACKER_MODEL_KEY, { ...options, allowStale: true });
}
