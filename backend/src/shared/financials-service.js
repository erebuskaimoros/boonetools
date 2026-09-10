import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appendFinancialsLivePoint, buildFinancialsPoints, buildLiveFinancialsPoint, daySeconds, financialsWindow, utcDay } from '../../../shared/financials/model.js';
import { fetchFinancialBondDay, fetchFinancialHistory, fetchFinancialLiveTotals, FINANCIALS_MIDGARD } from './financials-history.js';

const CACHE_VERSION = 1;
const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 60 * 60_000;
const LIVE_REFRESH_MS = 30_000;

export function createFinancialsService({ cacheDir, fetchImpl = fetch, requestJson, now = Date.now, requestSpacingMs = 650 } = {}) {
  let cache = { version: CACHE_VERSION, swaps: {}, earnings: {}, bonds: {} };
  let providerQueue = Promise.resolve();
  let lastRequestAt = 0;
  let cooldownUntil = 0;
  let health = null;
  let healthExpires = 0;
  let historyPromise = null;
  let historyError = '';
  let bondPromise = null;
  let livePromise = null;
  let liveBondPromise = null;
  let live = null;
  let liveExpires = 0;
  let liveError = '';
  let liveBondError = '';
  const activeBondDays = new Set();
  let stopped = false;
  let archiveFloor = null;
  let archiveFailures = 0;
  let bondError = '';
  const pendingDays = new Set();
  const failedDays = new Map();
  const cacheFile = cacheDir && path.join(cacheDir, 'history-v1.json');
  const ready = (async () => {
    if (!cacheFile) return;
    try {
      const stored = JSON.parse(await readFile(cacheFile, 'utf8'));
      if (stored.version === CACHE_VERSION && stored.swaps && stored.earnings && stored.bonds) cache = stored;
    } catch { /* A missing or invalid local cache can be rebuilt. */ }
  })();
  let saveQueue = Promise.resolve();
  function save() {
    if (!cacheFile) return Promise.resolve();
    const body = JSON.stringify(cache);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(`${cacheFile}.tmp`, body);
      await rename(`${cacheFile}.tmp`, cacheFile);
    }).catch((error) => { console.warn(`Financials local cache: ${error.message}`); });
    return saveQueue;
  }

  function getJson(url, lane = 'history') {
    const start = providerQueue.catch(() => {}).then(async () => {
      if (stopped) throw new Error('Financials collector stopped');
      if (now() < cooldownUntil) throw new Error('History provider is cooling down; retry later');
      const delay = Math.max(0, lastRequestAt + requestSpacingMs - now());
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      lastRequestAt = now();
    });
    providerQueue = start;
    return start.then(async () => {
      if (requestJson) {
        try { return await requestJson(url, { lane }); }
        catch (error) {
          if (error.status === 429 || String(error.providerKey || '').startsWith('global:')) {
            cooldownUntil = Math.max(now() + RETRY_MS, Date.parse(error.blockedUntil) || 0);
          }
          error.archiveUnavailable ||= /no archive|version does not exist|height.*not available/i.test(`${error.message} ${error.body || ''}`);
          throw error;
        }
      }
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(60_000), headers: { Accept: 'application/json', 'x-client-id': 'BooneTools-Financials' }
      });
      const body = await response.text();
      if (response.status === 429) cooldownUntil = now() + RETRY_MS;
      if (!response.ok || !body.trim().startsWith('{') && !body.trim().startsWith('[')) {
        const error = new Error(`History provider returned HTTP ${response.status}${/no archive/i.test(body) ? ': no archive available' : ''}`);
        error.archiveUnavailable = /no archive|version does not exist|height.*not available/i.test(body);
        throw error;
      }
      return JSON.parse(body);
    });
  }

  function historyIsFresh(window) {
    if (now() >= healthExpires) return false;
    for (const kind of ['swaps', 'earnings']) {
      for (let seconds = window.from; seconds < window.to; seconds += 86400) {
        const entry = cache[kind][seconds];
        if (!entry || seconds >= window.to - 2 * 86400 && now() - entry.fetchedAt > REFRESH_MS) return false;
      }
    }
    return true;
  }

  async function fillHistory(window) {
    if (historyIsFresh(window)) return;
    // Share fills across tabs and ranges. Re-check after an earlier fill finishes.
    while (historyPromise) await historyPromise.catch(() => {});
    if (historyIsFresh(window)) return;
    const work = async () => {
      if (now() >= healthExpires) {
        health = await getJson(`${FINANCIALS_MIDGARD}/health`);
        if (!Number(health?.lastAggregated?.timestamp)) throw new Error('History source watermark is unavailable');
        healthExpires = now() + REFRESH_MS;
      }
      for (const kind of ['swaps', 'earnings']) {
        const missing = [];
        for (let seconds = window.from; seconds < window.to; seconds += 86400) {
          const row = cache[kind][seconds];
          // Recently completed buckets can still settle at the indexer.
          if (!row || seconds >= window.to - 2 * 86400 && now() - row.fetchedAt > REFRESH_MS) missing.push(seconds);
        }
        if (!missing.length) continue;
        // Each contiguous missing span is at most 400 intervals per provider call.
        let first = missing[0];
        for (let index = 0; index < missing.length; index++) {
          if (index + 1 < missing.length && missing[index + 1] === missing[index] + 86400) continue;
          await fetchFinancialHistory(kind, {
            from: first, to: missing[index] + 86400, getJson,
            // Earnings include every pool. Small pages avoid multi-megabyte
            // responses and retain progress if the archive times out later.
            pageSize: kind === 'earnings' ? 60 : 400,
            async onPage(rows) {
              for (const row of rows) {
                if (Number(row.endTime) <= Number(health.lastAggregated.timestamp)) {
                  cache[kind][row.startTime] = { row, fetchedAt: now() };
                }
              }
              await save();
            }
          });
          first = missing[index + 1];
        }
      }
      await save();
    };
    const current = work();
    historyPromise = current;
    try { await current; } finally { if (historyPromise === current) historyPromise = null; }
  }

  function queueLiveBond(snapshot) {
    if (liveBondPromise || snapshot.bond || snapshot.through <= snapshot.from || stopped) return;
    liveBondPromise = fetchFinancialBondDay(snapshot.from, { getJson: (url) => getJson(url, 'live'),
      head: health?.lastAggregated, to: snapshot.through
    }).then((bond) => {
      if (live === snapshot) { snapshot.bond = bond; liveBondError = ''; }
    }).catch((error) => {
      if (live === snapshot) liveBondError = error.message;
    }).finally(() => { liveBondPromise = null; });
  }

  async function refreshLive(dayStart) {
    // In-progress data is memory-only. It must never become a cached closing
    // day, especially across UTC midnight or a dev-server restart.
    if (live?.from !== dayStart) {
      live = { from: dayStart, through: dayStart };
      liveExpires = 0;
      liveError = '';
      liveBondError = '';
    }
    if (livePromise) { await livePromise; return refreshLive(dayStart); }
    if (now() < liveExpires) return;
    liveExpires = now() + LIVE_REFRESH_MS;
    const work = async () => {
      try {
        const latest = await getJson(`${FINANCIALS_MIDGARD}/health`, 'live');
        const indexed = Number(latest?.lastAggregated?.timestamp);
        if (!Number.isFinite(indexed) || indexed < dayStart) throw new Error('Today is not indexed yet');
        health = latest;
        healthExpires = now() + REFRESH_MS;
        const through = Math.min(dayStart + 86400, Math.floor(Math.min(indexed, now() / 1000) / 300) * 300);
        if (through > dayStart && through > live.through) {
          const totals = await fetchFinancialLiveTotals(dayStart, through, { getJson: (url) => getJson(url, 'live') });
          live = { from: dayStart, through, ...totals };
          liveBondError = '';
        }
        liveError = '';
        queueLiveBond(live);
      } catch (error) { liveError = error.message; }
    };
    livePromise = work();
    try { await livePromise; } finally { livePromise = null; }
  }

  function queueBonds(points) {
    for (const point of [...points].reverse()) {
      if (point.incomeRune === null || cache.bonds[point.day] || activeBondDays.has(point.day) || archiveFloor && point.day <= archiveFloor
        || (failedDays.get(point.day) || 0) > now()) continue;
      pendingDays.add(point.day);
    }
    if (bondPromise || !pendingDays.size || stopped || cooldownUntil > now()) return;
    const worker = async () => {
      while (pendingDays.size && !stopped && now() >= cooldownUntil) {
        const day = [...pendingDays].sort().at(-1);
        pendingDays.delete(day);
        if (cache.bonds[day] || archiveFloor && day <= archiveFloor) continue;
        activeBondDays.add(day);
        try {
          cache.bonds[day] = await fetchFinancialBondDay(daySeconds(day), { getJson: (url) => getJson(url, 'archive'), head: health?.lastAggregated });
          archiveFailures = 0;
          bondError = '';
          await save();
        } catch (error) {
          if (stopped) break;
          bondError = error.message;
          failedDays.set(day, now() + (error.archiveUnavailable || cooldownUntil > now() ? RETRY_MS : 60_000));
          if (error.archiveUnavailable) {
            archiveFailures++;
            if (archiveFailures >= 3) archiveFloor = day;
          } else archiveFailures = 0;
          // A shared breaker should pause acquisition, not drain thousands of
          // dates through database-only cooldown failures.
          if (error.skipProvider) break;
        } finally { activeBondDays.delete(day); }
      }
    };
    // Archive responses include large validator lists. Keep a small fixed
    // number in flight while retaining the shared provider start-rate limit.
    bondPromise = Promise.all(Array.from({ length: 3 }, worker)).finally(() => { bondPromise = null; });
  }

  function snapshot(range = '30d') {
      const window = financialsWindow(range, now());
      const historyPoints = buildFinancialsPoints({
        ...window,
        swaps: Object.values(cache.swaps).map((entry) => entry.row),
        earnings: Object.values(cache.earnings).map((entry) => entry.row), bonds: cache.bonds
      });
      const currentLive = live?.from === window.to ? live : { from: window.to, through: window.to };
      const points = appendFinancialsLivePoint(historyPoints, buildLiveFinancialsPoint(currentLive), range);
      const aprDays = points.filter((point) => point.bondingApr !== null).length;
      const pending = points.filter((point) => pendingDays.has(point.day)).length;
      return {
        range, points,
        asOf: health?.lastAggregated?.timestamp ? new Date(Number(health.lastAggregated.timestamp) * 1000).toISOString() : null,
        throughDay: utcDay(window.to), historyStart: '2021-04-13',
        stale: Boolean(historyError) || !health?.lastAggregated?.timestamp || health?.inSync === false || now() - Number(health?.lastAggregated?.timestamp) * 1000 > 15 * 60_000,
        error: historyError,
        live: {
          day: utcDay(currentLive.from), through: currentLive.through > currentLive.from ? new Date(currentLive.through * 1000).toISOString() : null,
          refreshMs: LIVE_REFRESH_MS, intervalSeconds: 300,
          stale: Boolean(liveError) || health?.inSync === false || now() / 1000 - currentLive.through > 600,
          error: liveError, bondError: liveBondError, bondPending: Boolean(liveBondPromise)
        },
        bonding: { days: aprDays, pending: pending + points.filter((point) => activeBondDays.has(point.day)).length, error: bondError, archiveFloor },
        sources: { volume: 'liquify-midgard:history/swaps', income: 'liquify-midgard:history/earnings', bond: 'liquify-rpc:types.Query/Nodes' }
      };
  }

  async function refreshHistory(range = '30d') {
    await ready;
    try { await fillHistory(financialsWindow(range, now())); historyError = ''; }
    catch (error) { historyError = error.message; }
    queueBonds(snapshot(range).points.filter((point) => !point.partial));
  }

  return {
    refreshHistory,
    async refreshLive() { await ready; await refreshLive(financialsWindow('30d', now()).to); },
    async getSnapshot(range = '30d') { await ready; return snapshot(range); },
    async getHistory(range = '30d') {
      await Promise.all([refreshHistory(range), this.refreshLive()]);
      const result = snapshot(range);
      if (historyError && !result.points.some((point) => point.incomeRune !== null || point.volumeRune !== null)) throw new Error(historyError);
      return result;
    },
    async stop() { stopped = true; await Promise.allSettled([bondPromise, historyPromise, livePromise, liveBondPromise]); await saveQueue; }
  };
}
