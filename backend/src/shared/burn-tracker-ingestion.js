import { config } from '../lib/config.js';
import { sleep } from '../lib/utils.js';
import { fetchMidgard, MIDGARD_BASES } from './midgard.js';
import {
  BURN_TRACKER_START_DATE,
  incomeBurnBase,
  incomeBurnPool,
  parseBurnTrackerInterval
} from '../../../shared/burn-tracker/model.js';
import {
  loadBurnTrackerPendingDays,
  loadBurnTrackerTotals,
  getBurnTrackerSyncState,
  updateBurnTrackerSyncState,
  upsertBurnTrackerDays
} from './burn-tracker-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date.toISOString().slice(0, 10);
}

export function shiftBurnTrackerDay(value, days) {
  return dateKey(new Date(Date.parse(`${dateKey(value)}T00:00:00Z`) + (days * DAY_MS)));
}

function unixStart(day) {
  return Math.floor(Date.parse(`${dateKey(day)}T00:00:00Z`) / 1000);
}

function nowDate(value) {
  const resolved = typeof value === 'function' ? value() : value;
  const date = resolved instanceof Date ? resolved : new Date(resolved || Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
}

async function fetchEarnings(path, options = {}) {
  const fetcher = options.fetchMidgard || fetchMidgard;
  return fetcher(path, {
    cooldownClient: options.client,
    ...(options.bases ? { bases: options.bases } : {}),
    validateResponse: (_path, payload) => (
      path.includes('interval=')
        ? !Array.isArray(payload?.intervals)
        : !payload?.meta || typeof payload.meta !== 'object'
    )
  });
}

export async function fetchBurnTrackerDailyHistory(options = {}) {
  const startDate = dateKey(options.startDate || BURN_TRACKER_START_DATE);
  const endDate = dateKey(options.endDate || nowDate(options.now));
  const count = Math.min(400, Math.max(1, Math.trunc(Number(options.count)) || 400));
  const maxPages = Math.max(1, Math.trunc(Number(options.maxPages)) || 10);
  const rowsByDay = new Map();
  let cursor = unixStart(startDate);
  let pages = 0;

  while (pages < maxPages) {
    const params = new URLSearchParams({
      interval: 'day',
      from: String(cursor),
      count: String(count)
    });
    const payload = await fetchEarnings(`/history/earnings?${params}`, options);
    const intervals = Array.isArray(payload?.intervals) ? payload.intervals : [];
    pages += 1;
    for (const interval of intervals) {
      const row = parseBurnTrackerInterval(interval);
      if (row.day >= startDate && row.day <= endDate) rowsByDay.set(row.day, row);
    }
    const lastInterval = intervals.at(-1);
    const nextCursor = Number(lastInterval?.endTime ?? lastInterval?.end_time);
    const lastDay = rowsByDay.size ? [...rowsByDay.keys()].sort().at(-1) : '';
    if (!intervals.length || intervals.length < count || lastDay >= endDate) break;
    if (!Number.isFinite(nextCursor) || nextCursor <= cursor) {
      throw new Error('Midgard earnings pagination did not advance');
    }
    cursor = nextCursor;
    if (config.burnTrackerRequestDelayMs > 0 && options.skipDelay !== true) {
      await sleep(config.burnTrackerRequestDelayMs);
    }
  }

  if (pages >= maxPages && [...rowsByDay.keys()].sort().at(-1) < endDate) {
    throw new Error(`Burn Tracker earnings backfill exceeded ${maxPages} pages`);
  }
  return { rows: [...rowsByDay.values()].sort((a, b) => a.day.localeCompare(b.day)), pages };
}

export async function fetchBurnTrackerCurrentDay(options = {}) {
  const now = nowDate(options.now);
  const day = dateKey(now);
  const params = new URLSearchParams({
    from: String(unixStart(day)),
    to: String(Math.floor(now.getTime() / 1000))
  });
  const payload = await fetchEarnings(`/history/earnings?${params}`, options);
  return parseBurnTrackerInterval(payload.meta, {
    day,
    partial: true,
    source: 'liquify-midgard-earnings-live'
  });
}

export async function fetchBurnTrackerAllTime(options = {}) {
  const payload = await fetchEarnings('/history/earnings', options);
  return {
    burn_e8: incomeBurnBase(payload.meta, '0'),
    source_json: payload.meta
  };
}

export async function ingestBurnTrackerHistory(client, options = {}) {
  const now = nowDate(options.now);
  const today = dateKey(now);
  const configuredStart = dateKey(options.configuredStartDate || config.burnTrackerStartDate || BURN_TRACKER_START_DATE);
  const previous = await (options.getSyncState || getBurnTrackerSyncState)(client);
  const previousStats = previous?.stats_json || {};
  const pending = await (options.loadPendingDays || loadBurnTrackerPendingDays)(client, configuredStart, today);
  const upsert = options.upsert || upsertBurnTrackerDays;
  const bases = [options.historyBase || MIDGARD_BASES[0]];
  const errors = [];
  let pages = 0;
  let written = 0;
  let completed = [];
  // Persist live work independently: an archive or audit failure must not discard it.
  const current = await (options.fetchCurrent || fetchBurnTrackerCurrentDay)({ ...options, client, now });
  current.partial = true;
  current.completed_at = null;
  written += await upsert(client, [current]);
  if (pending.length || options.full) {
    try {
      const health = await (options.fetchMidgard || fetchMidgard)('/health', { cooldownClient: client, bases });
      const watermark = Number(health?.lastAggregated?.timestamp) * 1000;
      if (health.database !== true || health.inSync !== true || !(Number(health.lastAggregated?.height) > 0)
        || !Number.isFinite(watermark) || watermark <= 0 || watermark > nowDate(options.healthNow).getTime()) {
        throw new Error('Burn history aggregation watermark unavailable');
      }
      const requested = options.full
        ? Array.from({ length: Math.max(0, Math.round((unixStart(today) - unixStart(configuredStart)) / 86400)) },
          (_, index) => shiftBurnTrackerDay(configuredStart, index)) : pending;
      const ready = requested.filter((day) => unixStart(shiftBurnTrackerDay(day, 1)) * 1000 <= watermark);
      const ranges = [];
      for (const day of ready) {
        const previousRange = ranges.at(-1);
        if (previousRange && day === shiftBurnTrackerDay(previousRange.end, 1) && previousRange.days < 400) {
          previousRange.end = day; previousRange.days++;
        } else ranges.push({ start: day, end: day, days: 1 });
      }
      // Rotate the bounded historical allowance so a permanent gap cannot starve other days.
      const budget = options.full ? ranges.length : Math.max(1, Number(options.historyRequestLimit ?? config.burnTrackerHistoryRequestLimit) || 1);
      const offset = ranges.length > budget ? Math.floor(now.getTime() / 300000) % ranges.length : 0;
      for (const range of [...ranges.slice(offset), ...ranges.slice(0, offset)].slice(0, budget)) {
        const history = await (options.fetchDaily || fetchBurnTrackerDailyHistory)({ ...options, client, bases,
          startDate: range.start, endDate: range.end, count: range.days, maxPages: 1 });
        pages += history.pages;
        const rows = history.rows.filter((row) => row.day >= range.start && row.day <= range.end).map((row) => {
          const end = unixStart(shiftBurnTrackerDay(row.day, 1)) * 1000;
          const burnLane = incomeBurnPool(row.source_json);
          const complete = row.day < today && end <= watermark && /^\d+$/.test(String(row.burn_e8 ?? ''))
            && Array.isArray(row.source_json?.pools)
            && (!burnLane || incomeBurnBase(row.source_json, null) !== null)
            && (row.burn_e8 === '0' || Number(row.rune_price_usd) > 0)
            && Date.parse(row.interval_start) === unixStart(row.day) * 1000 && Date.parse(row.interval_end) === end;
          return { ...row, partial: !complete, completed_at: complete ? now.toISOString() : null };
        });
        written += await upsert(client, rows, { force: Boolean(options.full) });
        completed.push(...rows.filter((row) => row.completed_at).map((row) => row.day));
        if (rows.filter((row) => row.completed_at).length < range.days) errors.push(`Incomplete burn history ${range.start}..${range.end}`);
      }
    } catch (error) { errors.push(error?.message || String(error)); }
  }
  const totals = await (options.loadTotals || loadBurnTrackerTotals)(client, configuredStart, today);
  const derivedTotal = totals.complete ? (BigInt(totals.completed_burn_e8) + BigInt(totals.current_burn_e8)).toString() : null;
  const reconcileInterval = Math.max(60000, Number(options.reconcileIntervalMs ?? config.burnTrackerReconcileIntervalMs) || 86400000);
  const reconciledAt = Date.parse(previousStats.reconciled_at || '');
  let audit = {};
  if (options.full || !totals.complete || !Number.isFinite(reconciledAt) || now.getTime() - reconciledAt >= reconcileInterval) {
    try {
      const allTime = await (options.fetchAllTime || fetchBurnTrackerAllTime)({ ...options, client });
      audit = { all_time_burn_e8: allTime.burn_e8, reconciled_at: now.toISOString(),
        reconciliation_delta_e8: derivedTotal === null ? null : (BigInt(allTime.burn_e8) - BigInt(derivedTotal)).toString() };
    } catch (error) { errors.push(`Burn reconciliation: ${error?.message || error}`); }
  }
  const stats = { ...previousStats, ...audit, pages, rows: completed.length + 1, upserted: written,
    current_day: today, current_day_partial: true, source: 'liquify-midgard-earnings',
    derived_total_burn_e8: derivedTotal, baseline_complete: totals.complete,
    pending_days: Math.max(0, pending.length - completed.length) };
  await (options.updateSyncState || updateBurnTrackerSyncState)(client, { startDate: configuredStart,
    nextDay: pending.find((day) => !completed.includes(day)) || today,
    lastCompletedDay: completed.sort().at(-1) || previous?.last_completed_day || null,
    lastError: errors.join('; '), stats });
  return { start_date: configuredStart, end_date: today, ...stats };
}
