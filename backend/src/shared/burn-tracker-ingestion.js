import { config } from '../lib/config.js';
import { sleep } from '../lib/utils.js';
import { fetchMidgard } from './midgard.js';
import {
  BURN_TRACKER_START_DATE,
  incomeBurnBase,
  parseBurnTrackerInterval
} from '../../../shared/burn-tracker/model.js';
import {
  loadBurnTrackerCoverage,
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
  const configuredStart = options.configuredStartDate
    || config.burnTrackerStartDate
    || BURN_TRACKER_START_DATE;
  const coverage = await (options.loadCoverage || loadBurnTrackerCoverage)(client);
  const lookbackDays = Math.max(1, Math.trunc(Number(
    options.lookbackDays ?? config.burnTrackerRecentLookbackDays
  )) || 7);
  const needsBackfill = options.full === true || !coverage?.first_day;
  const startDate = dateKey(options.startDate || (needsBackfill
    ? configuredStart
    : [configuredStart, shiftBurnTrackerDay(today, -(lookbackDays - 1))].sort().at(-1)));

  try {
    const history = await (options.fetchDaily || fetchBurnTrackerDailyHistory)({
      ...options,
      client,
      startDate,
      endDate: today
    });
    const current = await (options.fetchCurrent || fetchBurnTrackerCurrentDay)({
      ...options,
      client,
      now
    });
    const allTime = await (options.fetchAllTime || fetchBurnTrackerAllTime)({
      ...options,
      client
    });
    const rowsByDay = new Map(history.rows.map((row) => [row.day, row]));
    rowsByDay.set(current.day, current);
    const rows = [...rowsByDay.values()].sort((left, right) => left.day.localeCompare(right.day));
    const upserted = await (options.upsert || upsertBurnTrackerDays)(client, rows);
    const lastCompletedDay = shiftBurnTrackerDay(today, -1);
    const stats = {
      all_time_burn_e8: allTime.burn_e8,
      pages: history.pages,
      rows: rows.length,
      upserted,
      current_day: today,
      current_day_partial: true,
      source: 'liquify-midgard-earnings'
    };
    await (options.updateSyncState || updateBurnTrackerSyncState)(client, {
      startDate: configuredStart,
      nextDay: today,
      lastCompletedDay,
      stats
    });
    return { start_date: startDate, end_date: today, ...stats };
  } catch (error) {
    await (options.updateSyncState || updateBurnTrackerSyncState)(client, {
      startDate: configuredStart,
      nextDay: startDate,
      lastCompletedDay: coverage?.last_day || null,
      lastError: error?.message || String(error),
      stats: { failed_at: new Date().toISOString() }
    }).catch(() => {});
    throw error;
  }
}
