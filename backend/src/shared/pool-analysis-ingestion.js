import { fetchPoolAnalysisSnapshot, combinePoolAnalysisSnapshots } from './pool-analysis-rolling.js';
import { config } from '../lib/config.js';
import { sleep } from '../lib/utils.js';
import { fetchMidgard, MIDGARD_BASES } from './midgard.js';
import { coreSnapshotValue, getThorNodeCoreSnapshot } from './thornode-core-snapshot.js';
import {
  POOL_ANALYSIS_START_DATE,
  POOL_ANALYSIS_TABLE_PERIODS,
  assetIdentity,
  nonNegativeBaseString,
  parsePoolAnalysisDepthInterval,
  parsePoolAnalysisSwapInterval
} from './pool-analysis.js';
import {
  loadPoolAnalysisPendingDays,
  loadPoolAnalysisCompletedDays,
  loadPoolAnalysisRollingEdges,
  savePoolAnalysisIntradaySnapshot,
  loadPoolAnalysisBoundarySnapshots,
  savePoolAnalysisRollingSnapshot,
  markPoolAnalysisRollingFailure,
  updatePoolAnalysisSyncState,
  upsertPoolAnalysisDepthDays,
  upsertPoolAnalysisDays
} from './pool-analysis-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = { swaps: 100, depth: 400 };

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid Pool Analysis date: ${value}`);
  return date.toISOString().slice(0, 10);
}

function unixStart(day) {
  return Math.floor(Date.parse(`${dateKey(day)}T00:00:00Z`) / 1000);
}

function shiftDay(day, amount) {
  return dateKey(new Date((unixStart(day) * 1000) + (amount * DAY_MS)));
}

function resolvedNow(value) {
  const candidate = typeof value === 'function' ? value() : value;
  const date = candidate instanceof Date ? candidate : new Date(candidate || Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
}

async function historyRequest(path, options = {}) {
  return (options.fetchMidgard || fetchMidgard)(path, {
    cooldownClient: options.client,
    ...(options.bases ? { bases: options.bases } : {}),
    validateResponse: (_path, payload) => !Array.isArray(payload?.intervals)
  });
}

async function dailyHistory({ path, startDate, endDate, query = {}, parse, options = {} }) {
  const count = Math.min(options.maxCount || 100, Math.max(1, Math.trunc(Number(options.count)) || 100));
  const maxPages = Math.max(1, Math.trunc(Number(options.maxPages ?? config.poolAnalysisMaxPages)) || 30);
  const rows = [];
  const end = unixStart(shiftDay(endDate, 1));
  let cursor = unixStart(startDate);
  let pages = 0;
  while (cursor < end && pages < maxPages) {
    const pageEnd = Math.min(end, cursor + count * 86400);
    // Midgard allows only two of from/to/count. Exact bounds ensure a gap
    // request cannot refetch the completed days beside it.
    const params = new URLSearchParams({ ...query, interval: 'day', from: String(cursor), to: String(pageEnd) });
    const payload = await historyRequest(`${path}?${params}`, options);
    pages += 1;
    rows.push(...parse(payload.intervals).filter((row) => {
      const start = unixStart(row.day);
      return start >= cursor && start < pageEnd;
    }));
    cursor = pageEnd;
    if (cursor < end && config.poolAnalysisRequestDelayMs > 0 && options.skipDelay !== true) {
      await sleep(config.poolAnalysisRequestDelayMs);
    }
  }
  if (cursor < end) throw new Error(`Pool Analysis history exceeded ${maxPages} pages for ${path}`);
  return { rows, pages };
}

export async function fetchPoolAnalysisSwapHistory(asset, options = {}) {
  const normalizedAsset = assetIdentity(asset).asset;
  const today = dateKey(resolvedNow(options.now));
  return dailyHistory({
    path: '/history/swaps',
    startDate: dateKey(options.startDate || POOL_ANALYSIS_START_DATE),
    endDate: dateKey(options.endDate || today),
    query: { pool: normalizedAsset }, options,
    parse: (intervals) => intervals.map((interval) => parsePoolAnalysisSwapInterval(interval, {
      asset: normalizedAsset,
      partial: dateKey(new Date(Number(interval.startTime ?? interval.start_time) * 1000)) >= today
    }))
  });
}

export async function fetchPoolAnalysisDepthHistory(asset, options = {}) {
  const normalizedAsset = assetIdentity(asset).asset;
  const today = dateKey(resolvedNow(options.now));
  return dailyHistory({
    path: `/history/depths/${encodeURIComponent(normalizedAsset)}`,
    startDate: dateKey(options.startDate || POOL_ANALYSIS_START_DATE),
    endDate: dateKey(options.endDate || today),
    options: { ...options, count: options.count ?? 400, maxCount: 400 },
    parse: (intervals) => intervals.map((interval) => parsePoolAnalysisDepthInterval(interval, {
      asset: normalizedAsset,
      partial: dateKey(new Date(Number(interval.startTime) * 1000)) >= today
    }))
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

function validPrice(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
}

function completeHistoryRow(row, lane, today, watermark) {
  const dayEnd = unixStart(shiftDay(row.day, 1)) * 1000;
  const amounts = lane === 'swaps'
    ? ['volume_rune_e8', 'volume_usd_e2', 'fees_rune_e8']
    : ['rune_depth_e8', 'asset_depth_e8'];
  const empty = amounts.every((key) => nonNegativeBaseString(row[key]) === '0');
  const price = row[lane === 'swaps' ? 'rune_price_usd' : 'asset_price_usd'];
  return row.day < today && watermark >= dayEnd && row.partial !== true
    && Date.parse(row.interval_end) === dayEnd
    && (lane !== 'swaps' || Date.parse(row.interval_start) === unixStart(row.day) * 1000)
    && amounts.every((key) => nonNegativeBaseString(row[key]) !== null)
    && (empty || (validPrice(price) && Number(price) > 0));
}

function currentDepthRows(core, assets, now, maxAgeMs) {
  const payload = core?.payload || core;
  const meta = payload?.field_meta?.pools;
  const fetchedMs = Date.parse(meta?.fetched_at);
  const today = dateKey(now);
  if (core?.stale || payload?.stale || !meta || !['fresh', 'cached'].includes(meta.status) || !Number.isFinite(fetchedMs)
    || fetchedMs > now.getTime() || now.getTime() - fetchedMs > maxAgeMs
    || dateKey(new Date(fetchedMs)) !== today) return [];
  const assetSet = new Set(assets);
  return coreSnapshotValue(core, 'pools', []).flatMap((pool) => {
    const asset = assetIdentity(pool.asset).asset;
    const rune = nonNegativeBaseString(pool.balance_rune);
    const balance = nonNegativeBaseString(pool.balance_asset);
    const price = nonNegativeBaseString(pool.asset_tor_price);
    if (!assetSet.has(asset) || rune === null || balance === null || price === null) return [];
    const priceUsd = Number(price) / 1e8;
    if (!Number.isFinite(priceUsd) || (priceUsd === 0 && (rune !== '0' || balance !== '0'))) return [];
    return [{ asset, day: today, rune_depth_e8: rune, asset_depth_e8: balance,
      asset_price_usd: String(priceUsd), interval_end: new Date(fetchedMs).toISOString(),
      observed_at: new Date(fetchedMs).toISOString(), partial: true,
      completed_at: null, source: 'thornode-core:pools' }];
  });
}

function pendingRanges(pending, yesterday) {
  const grouped = new Map();
  for (const row of pending) {
    if (!HISTORY_DAYS[row.lane] || row.day > yesterday) continue;
    const key = `${row.asset}:${row.lane}`;
    if (!grouped.has(key)) grouped.set(key, { asset: row.asset, lane: row.lane, days: new Set() });
    grouped.get(key).days.add(row.day);
  }
  const ranges = [];
  for (const { asset, lane, days } of grouped.values()) {
    let range;
    for (const day of [...days].sort()) {
      if (!range || day !== shiftDay(range.endDate, 1) || range.days >= HISTORY_DAYS[lane]) {
        range = { asset, lane, startDate: day, endDate: day, days: 1 };
        ranges.push(range);
      } else {
        range.endDate = day;
        range.days += 1;
      }
    }
  }
  return ranges.sort((a, b) => Number(b.endDate === yesterday) - Number(a.endDate === yesterday)
    || a.startDate.localeCompare(b.startDate) || a.asset.localeCompare(b.asset) || a.lane.localeCompare(b.lane));
}

async function historyWatermark(client, options, bases) {
  const health = await (options.fetchMidgard || fetchMidgard)('/health', {
    cooldownClient: client, bases,
    validateResponse: (_path, payload) => !payload || typeof payload !== 'object'
  });
  const timestamp = Number(health?.lastAggregated?.timestamp) * 1000;
  const receivedAt = resolvedNow(options.healthNow); // Health follows the live sweep, which can take minutes.
  if (health.database !== true || health.inSync !== true || !(Number(health.lastAggregated?.height) > 0)
    || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > receivedAt.getTime()) {
    throw new Error('Midgard aggregation watermark unavailable or not in sync');
  }
  return timestamp;
}

export async function ingestPoolAnalysisHistory(client, options = {}) {
  const now = resolvedNow(options.now);
  const today = dateKey(now);
  const yesterday = shiftDay(today, -1);
  const recentDays = Math.max(1, Math.trunc(Number(options.recentDays ?? config.poolAnalysisRecentLookbackDays)) || 35);
  const startDate = dateKey(options.startDate || (options.full
    ? config.poolAnalysisStartDate || POOL_ANALYSIS_START_DATE : shiftDay(today, -(recentDays - 1))));
  const configuredAssets = Array.isArray(options.assets) ? options.assets : null;
  let core = options.coreSnapshot;
  let coreError = '';
  if (core === undefined) {
    try { core = await (options.getCoreSnapshot || getThorNodeCoreSnapshot)({ client, allowStale: true }); }
    catch (error) { coreError = error?.message || String(error); }
  }
  const assets = [...new Set((configuredAssets || coreSnapshotValue(core, 'pools', [])
    .filter((pool) => ['available', 'staged'].includes(String(pool?.status || '').toLowerCase()))
    .map((pool) => pool.asset)).map((asset) => assetIdentity(asset).asset).filter(Boolean))].sort();
  if (!assets.length) throw new Error('Pool Analysis ingestion found no pools');
  const concurrency = Math.max(1, Math.trunc(Number(options.concurrency ?? config.poolAnalysisConcurrency)) || 2);
  const byAsset = new Map(assets.map((asset) => [asset, {
    swaps: { rows: [], pages: 0, errors: [] }, depth: { rows: [], pages: 0, errors: [] }
  }]));
  let upserted = 0;
  async function persist(lane, rows) {
    const upsert = lane === 'swaps' ? options.upsert || upsertPoolAnalysisDays : options.upsertDepths || upsertPoolAnalysisDepthDays;
    const count = await upsert(client, rows, { force: Boolean(options.full) });
    if (lane === 'swaps') upserted += count;
  }
  async function request(task, watermark = 0, bases) {
    const state = byAsset.get(task.asset)[task.lane];
    state.pages += 1;
    try {
      const fetcher = task.lane === 'swaps' ? options.fetchSwapHistory || fetchPoolAnalysisSwapHistory
        : options.fetchDepthHistory || fetchPoolAnalysisDepthHistory;
      const result = await fetcher(task.asset, { ...options, client, now,
        startDate: task.startDate, endDate: task.endDate, maxPages: 1, ...(bases ? { bases } : {}) });
      const rows = result.rows.filter((row) => row.asset === task.asset
        && row.day >= task.startDate && row.day <= task.endDate).map((row) => {
        const complete = completeHistoryRow(row, task.lane, today, watermark);
        return { ...row, partial: !complete, completed_at: complete ? now.toISOString() : null,
          ...(task.lane === 'depth' ? { observed_at: now.toISOString() } : {}) };
      });
      await persist(task.lane, rows);
      state.rows.push(...rows);
      if (task.endDate < today && rows.filter((row) => row.completed_at).length < task.days) {
        state.errors.push(`Incomplete history ${task.startDate}..${task.endDate}`);
      }
    } catch (error) { state.errors.push(error?.message || String(error)); }
  }

  let watermark = 0;
  let watermarkError = '';
  const bases = [options.historyBase || MIDGARD_BASES[0]];
  const rollingEdges = new Map();
  if (options.rolling) {
    try { watermark = await historyWatermark(client, options, bases); }
    catch (error) { watermarkError = error?.message || String(error); }
    await mapWithConcurrency(assets, concurrency, async (asset) => {
      const state = byAsset.get(asset).swaps;
      try {
        if (!watermark) throw new Error(watermarkError);
        const cutoff = Math.floor(watermark / 900000) * 900;
        const cached = await (options.loadRollingEdges || loadPoolAnalysisRollingEdges)(client, asset, cutoff);
        const onHead = async (head) => {
          await (options.saveIntradaySnapshot || savePoolAnalysisIntradaySnapshot)(client, head);
          const row = { ...head, partial: true, completed_at: null };
          await persist('swaps', [row]);
          state.rows.push(row);
        };
        const result = cached || await fetchPoolAnalysisSnapshot(asset, cutoff, {
          ...options, client, bases, onHead, onRequest: () => { state.pages++; }
        });
        if (cached) await onHead(cached.head);
        rollingEdges.set(asset, result);
      } catch (error) {
        state.errors.push(error?.message || String(error));
        await (options.markRollingFailure || markPoolAnalysisRollingFailure)(client, asset, error?.message || String(error));
      }
    });
  }

  // Live work always precedes recovery, so a historical backlog cannot consume
  // its request allowance or prevent its data from reaching the read model.
  if (!options.rolling) await mapWithConcurrency(assets, concurrency, (asset) => request({ asset, lane: 'swaps', startDate: today, endDate: today, days: 1 }));
  const currentDepth = currentDepthRows(core, assets, now, Math.max(1, Number(
    options.coreMaxAgeMs ?? config.poolAnalysisCoreMaxAgeMs
  ) || 300000));
  for (const asset of assets) {
    const row = currentDepth.find((candidate) => candidate.asset === asset);
    if (row) {
      try { await persist('depth', [row]); byAsset.get(asset).depth.rows.push(row); }
      catch (error) { byAsset.get(asset).depth.errors.push(error?.message || String(error)); }
    } else byAsset.get(asset).depth.errors.push(coreError || 'Fresh current-day core pool depth unavailable');
  }

  let pending;
  if (options.full) {
    pending = [];
    for (const asset of assets) for (const lane of ['swaps', 'depth']) {
      for (let day = startDate; day <= yesterday; day = shiftDay(day, 1)) pending.push({ asset, lane, day });
    }
  } else pending = await (options.loadPendingDays || loadPoolAnalysisPendingDays)(client, { assets, startDate, today });
  const ranges = pendingRanges(pending, yesterday);
  const limit = options.full ? ranges.length : Math.max(0, Math.trunc(Number(
    options.historyRequestLimit ?? config.poolAnalysisHistoryRequestLimit
  )) || 0);
  if (!options.rolling && ranges.length && limit > 0) {
    try { watermark = await historyWatermark(client, options, bases); }
    catch (error) { watermarkError = error?.message || String(error); }
  }
  // Health and closed history share exactly one provider; a different fallback
  // must not borrow this provider's aggregation watermark.
  const ready = ranges.filter((range) => unixStart(shiftDay(range.endDate, 1)) * 1000 <= watermark);
  const newlyClosed = ready.filter((range) => range.endDate === yesterday);
  const backlog = ready.filter((range) => range.endDate !== yesterday);
  const available = Math.max(0, limit - newlyClosed.length);
  // Empty/erroring ranges must yield to other pools on later runs, including
  // within yesterday's priority group. The clock survives process restarts.
  const rotate = (rangesToRotate, slots) => {
    const offset = slots > 0 && rangesToRotate.length > slots
      ? Math.floor(now.getTime() / 900000) % rangesToRotate.length : 0;
    return [...rangesToRotate.slice(offset), ...rangesToRotate.slice(0, offset)];
  };
  const selected = [...rotate(newlyClosed, limit), ...rotate(backlog, available)].slice(0, limit);
  await mapWithConcurrency(selected, concurrency, (task) => request(task, watermark, bases));
  for (const [asset, edges] of rollingEdges) {
    try {
      const daily = await (options.loadCompletedDays || loadPoolAnalysisCompletedDays)(client, asset, edges.cutoff);
      const prefixes = await (options.loadBoundarySnapshots || loadPoolAnalysisBoundarySnapshots)(client, asset, edges.cutoff, POOL_ANALYSIS_TABLE_PERIODS);
      const periods = combinePoolAnalysisSnapshots(edges, daily, prefixes);
      await (options.saveRollingSnapshot || savePoolAnalysisRollingSnapshot)(client, asset, periods, new Date(edges.cutoff * 1000).toISOString());
    } catch (error) {
      byAsset.get(asset).swaps.errors.push(error?.message || String(error));
      await (options.markRollingFailure || markPoolAnalysisRollingFailure)(client, asset, error?.message || String(error));
    }
  }
  const allStates = [...byAsset.values()];
  for (const [asset, state] of byAsset) {
    const days = state.swaps.rows.map((row) => row.day).sort();
    const completedDays = state.swaps.rows.filter((row) => row.completed_at).map((row) => row.day).sort();
    const pendingForAsset = pending.filter((row) => row.asset === asset);
    await (options.updateSyncState || updatePoolAnalysisSyncState)(client, {
      asset, firstDay: days[0] || null, lastDay: days.at(-1) || null,
      lastCompletedDay: completedDays.at(-1) || null,
      lastError: [...state.swaps.errors, ...state.depth.errors.map((error) => `Depth: ${error}`), watermarkError].filter(Boolean).join('; '),
      stats: { full: Boolean(options.full), start_date: startDate, end_date: today,
        rows: state.swaps.rows.length, swap_pages: state.swaps.pages, depth_pages: state.depth.pages,
        depth_rows: state.depth.rows.length, completed_swap_days: completedDays.length,
        completed_depth_days: state.depth.rows.filter((row) => row.completed_at).length,
        pending_swap_days: pendingForAsset.filter((row) => row.lane === 'swaps').length - completedDays.length,
        pending_depth_days: pendingForAsset.filter((row) => row.lane === 'depth').length - state.depth.rows.filter((row) => row.completed_at).length,
        watermark: watermark ? new Date(watermark).toISOString() : null, watermark_error: watermarkError }
    });
  }
  return {
    full: Boolean(options.full), start_date: startDate, end_date: today, pools: assets.length,
    successful_pools: allStates.filter((state) => state.swaps.rows.length).length,
    failed_pools: allStates.filter((state) => state.swaps.errors.length).length,
    rows: allStates.reduce((total, state) => total + state.swaps.rows.length, 0), upserted,
    swap_pages: allStates.reduce((total, state) => total + state.swaps.pages, 0),
    depth_pages: allStates.reduce((total, state) => total + state.depth.pages, 0),
    depth_rows: allStates.reduce((total, state) => total + state.depth.rows.length, 0),
    failed_depth_pools: allStates.filter((state) => state.depth.errors.length).length,
    historical_requests: selected.length, pending_ranges: ranges.length,
    deferred_ranges: ranges.length - selected.length, watermark_error: watermarkError,
    live_depth_rows: currentDepth.length
  };
}
