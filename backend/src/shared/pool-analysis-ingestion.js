import { config } from '../lib/config.js';
import { sleep } from '../lib/utils.js';
import { fetchMidgard } from './midgard.js';
import { coreSnapshotValue, getThorNodeCoreSnapshot } from './thornode-core-snapshot.js';
import {
  POOL_ANALYSIS_START_DATE,
  assetIdentity,
  mergePoolAnalysisHistoryRows,
  parsePoolAnalysisEarningsIntervals,
  parsePoolAnalysisSwapInterval
} from './pool-analysis.js';
import {
  updatePoolAnalysisSyncState,
  upsertPoolAnalysisDays
} from './pool-analysis-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid Pool Analysis date: ${value}`);
  return date.toISOString().slice(0, 10);
}

function unixStart(day) {
  return Math.floor(Date.parse(`${dateKey(day)}T00:00:00Z`) / 1000);
}

function shiftDay(day, amount) {
  return dateKey(new Date(Date.parse(`${dateKey(day)}T00:00:00Z`) + (amount * DAY_MS)));
}

function resolvedNow(value) {
  const candidate = typeof value === 'function' ? value() : value;
  const date = candidate instanceof Date ? candidate : new Date(candidate || Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
}

async function historyRequest(path, options = {}) {
  const fetcher = options.fetchMidgard || fetchMidgard;
  return fetcher(path, {
    cooldownClient: options.client,
    validateResponse: (_path, payload) => !Array.isArray(payload?.intervals)
  });
}

async function dailyHistory({ path, startDate, endDate, query = {}, parse, options = {} }) {
  const count = Math.min(100, Math.max(1, Math.trunc(Number(options.count)) || 100));
  const maxPages = Math.max(1, Math.trunc(Number(
    options.maxPages ?? config.poolAnalysisMaxPages
  )) || 10);
  const rows = [];
  let cursor = unixStart(startDate);
  let pages = 0;
  let complete = false;
  while (pages < maxPages) {
    const params = new URLSearchParams({
      ...query,
      interval: 'day',
      from: String(cursor),
      count: String(count)
    });
    const payload = await historyRequest(`${path}?${params}`, options);
    const intervals = Array.isArray(payload?.intervals) ? payload.intervals : [];
    pages += 1;
    rows.push(...parse(intervals));
    if (!intervals.length) {
      complete = true;
      break;
    }
    const lastInterval = intervals.at(-1);
    const nextCursor = Number(lastInterval?.endTime ?? lastInterval?.end_time);
    if (!Number.isFinite(nextCursor) || nextCursor <= cursor) {
      throw new Error(`Midgard pagination did not advance for ${path}`);
    }
    const nextDay = dateKey(new Date(nextCursor * 1000));
    if (nextDay >= endDate) {
      complete = true;
      break;
    }
    cursor = nextCursor;
    if (config.poolAnalysisRequestDelayMs > 0 && options.skipDelay !== true) {
      await sleep(config.poolAnalysisRequestDelayMs);
    }
  }
  if (pages >= maxPages && !complete) {
    throw new Error(`Pool Analysis history exceeded ${maxPages} pages for ${path}`);
  }
  return { rows, pages };
}

export async function fetchPoolAnalysisSwapHistory(asset, options = {}) {
  const normalizedAsset = assetIdentity(asset).asset;
  const startDate = dateKey(options.startDate || POOL_ANALYSIS_START_DATE);
  const endDate = dateKey(options.endDate || resolvedNow(options.now));
  return dailyHistory({
    path: '/history/swaps',
    startDate,
    endDate,
    query: { pool: normalizedAsset },
    options,
    parse: (intervals) => intervals.map((interval) => parsePoolAnalysisSwapInterval(interval, {
      asset: normalizedAsset,
      partial: dateKey(new Date(Number(interval.startTime ?? interval.start_time) * 1000)) === endDate
    }))
  });
}

export async function fetchPoolAnalysisEarningsHistory(options = {}) {
  const startDate = dateKey(options.startDate || POOL_ANALYSIS_START_DATE);
  const endDate = dateKey(options.endDate || resolvedNow(options.now));
  return dailyHistory({
    path: '/history/earnings',
    startDate,
    endDate,
    options,
    parse: (intervals) => parsePoolAnalysisEarningsIntervals(intervals, { currentDay: endDate })
  });
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, run));
  return results;
}

async function upsertBatches(client, rows, upsert, batchSize = 2000) {
  let total = 0;
  for (let index = 0; index < rows.length; index += batchSize) {
    total += await upsert(client, rows.slice(index, index + batchSize));
  }
  return total;
}

export async function ingestPoolAnalysisHistory(client, options = {}) {
  const now = resolvedNow(options.now);
  const today = dateKey(now);
  const recentDays = Math.max(30, Math.trunc(Number(
    options.recentDays ?? config.poolAnalysisRecentLookbackDays
  )) || 35);
  const startDate = dateKey(options.startDate || (options.full
    ? config.poolAnalysisStartDate || POOL_ANALYSIS_START_DATE
    : shiftDay(today, -(recentDays - 1))));
  const configuredAssets = Array.isArray(options.assets) ? options.assets : null;
  const core = options.coreSnapshot || (configuredAssets ? null : await (
    options.getCoreSnapshot || getThorNodeCoreSnapshot
  )({ client, allowStale: true }));
  const assets = [...new Set((configuredAssets || coreSnapshotValue(core, 'pools', [])
    .filter((pool) => ['available', 'staged'].includes(String(pool?.status || '').toLowerCase()))
    .map((pool) => pool.asset))
    .map((asset) => assetIdentity(asset).asset)
    .filter(Boolean))].sort();
  if (!assets.length) throw new Error('Pool Analysis ingestion found no pools');

  const concurrency = Math.max(1, Math.trunc(Number(
    options.concurrency ?? config.poolAnalysisConcurrency
  )) || 2);
  const swapResults = await mapWithConcurrency(assets, concurrency, async (asset) => {
    try {
      const result = await (options.fetchSwapHistory || fetchPoolAnalysisSwapHistory)(asset, {
        ...options,
        client,
        startDate,
        endDate: today,
        now
      });
      return { asset, ...result, error: '' };
    } catch (error) {
      return { asset, rows: [], pages: 0, error: error?.message || String(error) };
    }
  });
  const successfulSwaps = swapResults.filter((result) => !result.error);
  if (!successfulSwaps.length) {
    throw new Error(`Pool Analysis swap history failed for all ${assets.length} pools`);
  }

  let earnings = { rows: [], pages: 0, error: '' };
  try {
    earnings = await (options.fetchEarningsHistory || fetchPoolAnalysisEarningsHistory)({
      ...options,
      client,
      startDate,
      endDate: today,
      now
    });
  } catch (error) {
    earnings = { rows: [], pages: 0, error: error?.message || String(error) };
  }

  const acceptedAssets = new Set(assets);
  const merged = mergePoolAnalysisHistoryRows([
    ...successfulSwaps.flatMap((result) => result.rows),
    ...earnings.rows.filter((row) => acceptedAssets.has(row.asset))
  ]);
  const upsert = options.upsert || upsertPoolAnalysisDays;
  const upserted = await upsertBatches(client, merged, upsert, options.batchSize);
  const rowsByAsset = new Map(assets.map((asset) => [asset, []]));
  for (const row of merged) rowsByAsset.get(row.asset)?.push(row);
  const lastCompletedDay = shiftDay(today, -1);
  for (const result of swapResults) {
    const rows = rowsByAsset.get(result.asset) || [];
    const days = rows.map((row) => row.day).sort();
    await (options.updateSyncState || updatePoolAnalysisSyncState)(client, {
      asset: result.asset,
      firstDay: days[0] || null,
      lastDay: days.at(-1) || null,
      lastCompletedDay: result.error ? null : lastCompletedDay,
      lastError: result.error,
      stats: {
        full: Boolean(options.full),
        start_date: startDate,
        end_date: today,
        rows: rows.length,
        swap_pages: result.pages,
        earnings_pages: earnings.pages,
        earnings_error: earnings.error
      }
    });
  }
  return {
    full: Boolean(options.full),
    start_date: startDate,
    end_date: today,
    pools: assets.length,
    successful_pools: successfulSwaps.length,
    failed_pools: swapResults.length - successfulSwaps.length,
    rows: merged.length,
    upserted,
    swap_pages: swapResults.reduce((total, result) => total + result.pages, 0),
    earnings_pages: earnings.pages,
    earnings_error: earnings.error
  };
}
