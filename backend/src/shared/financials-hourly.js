import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { financialHourlyPoint, financialHourlyWindow, sliceFinancialHourlyPayload } from '../../../shared/financials/hourly.js';
import { integerAmount } from '../../../shared/financials/model.js';
import { fetchFinancialLiveTotals } from './financials-history.js';

// Separate bounded cache: hourly acquisition never starts validator queries or
// touches the daily roster. Production supplies the shared provider dispatcher.
export function createFinancialsHourlyService({ cacheDir, requestJson, now = Date.now } = {}) {
  let cache = { version: 1, swaps: {}, earnings: {} }, live = null, health = null;
  let active, stopped = false, nextRefresh = 0, error = '';
  const controller = new AbortController();
  const file = cacheDir && path.join(cacheDir, 'hourly-v1.json');
  const ready = (async () => {
    if (!file) return;
    try {
      const stored = JSON.parse(await readFile(file, 'utf8'));
      if (stored.version === 1 && stored.swaps && stored.earnings) cache = stored;
    } catch { /* A cold hourly cache fills newest-first, in bounded chunks. */ }
  })();
  const getJson = route => requestJson(route, { service: 'midgard', lane: 'hourly', signal: controller.signal });
  async function save() {
    if (!file) return;
    await mkdir(cacheDir, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(cache));
    await rename(`${file}.tmp`, file);
  }
  async function fill(kind, from, to, indexed) {
    if (to <= from) return;
    const query = new URLSearchParams({ interval: 'hour', from: String(from), count: String((to - from) / 3600) });
    const result = await getJson(`/history/${kind}?${query}`);
    if (!Array.isArray(result?.intervals)) throw new Error(`Invalid hourly ${kind} response`);
    const rows = new Map(result.intervals.map(row => [Number(row.startTime), row]));
    const fields = kind === 'swaps' ? ['totalVolume', 'totalVolumeUSD'] : ['earnings', 'liquidityFees'];
    const accepted = [];
    for (let start = from; start < to; start += 3600) {
      const row = rows.get(start);
      if (!row || Number(row.endTime) !== start + 3600 || start + 3600 > indexed
        || fields.some(field => integerAmount(row[field]) === null)) throw new Error(`Incomplete hourly ${kind} coverage`);
      const { pools, ...compact } = row;
      accepted.push([start, { row: compact, fetchedAt: now() }]);
    }
    for (const [start, entry] of accepted) cache[kind][start] = entry;
    await save();
  }
  async function acquire() {
    await ready;
    const window = financialHourlyWindow('30d', now());
    const current = window.to - 3600;
    health = await getJson('/health');
    const indexed = Number(health?.lastAggregated?.timestamp);
    if (!(indexed > 0)) throw new Error('Hourly source watermark is unavailable');
    const closedTo = Math.min(current, Math.floor(indexed / 3600) * 3600);
    // First deliver the latest 24 buckets. Thereafter refresh two recent hours
    // for indexer corrections, then backfill at most five days per pass.
    for (const kind of ['swaps', 'earnings']) {
      const recentFrom = current - 23 * 3600;
      const missing = [];
      for (let start = recentFrom; start < closedTo; start += 3600) {
        const entry = cache[kind][start];
        if (!entry || start >= current - 7200 && now() - entry.fetchedAt >= 300_000) missing.push(start);
      }
      if (missing.length) await fill(kind, missing[0], closedTo, indexed);
    }
    const through = Math.min(window.to, Math.floor(Math.min(indexed, now() / 1000) / 300) * 300);
    if (live?.from !== current) live = null;
    if (through > current && through > (live?.through || 0)) {
      const totals = await fetchFinancialLiveTotals(current, through, { getJson });
      live = { from: current, through, ...totals };
    }
    for (const kind of ['swaps', 'earnings']) {
      let lastMissing;
      for (let start = current - 24 * 3600; start >= window.from; start -= 3600) {
        if (!cache[kind][start]) { lastMissing = start; break; }
      }
      if (lastMissing !== undefined) {
        let first = lastMissing;
        while (first > window.from && lastMissing - first < 119 * 3600 && !cache[kind][first - 3600]) first -= 3600;
        await fill(kind, first, lastMissing + 3600, indexed);
      }
      for (const start of Object.keys(cache[kind])) if (Number(start) < window.from) delete cache[kind][start];
    }
    await save();
  }
  return {
    async refresh() {
      if (stopped) return;
      if (active) return active;
      if (now() < nextRefresh) return;
      nextRefresh = now() + 60_000;
      active = acquire().then(() => { error = ''; }).catch(failure => {
        if (stopped) return;
        error = failure.message;
        nextRefresh = Math.max(nextRefresh, Date.parse(failure.retryAt || failure.blockedUntil) || 0);
      }).finally(() => { active = null; });
      return active;
    },
    async getSnapshot(range = '24h') {
      await ready;
      const { from, to } = financialHourlyWindow('30d', now()), points = [];
      for (let start = from; start < to; start += 3600) {
        points.push(start === to - 3600
          ? financialHourlyPoint(start, live?.from === start ? live.swaps : null, live?.from === start ? live.earnings : null,
            live?.from === start ? live.through : start)
          : financialHourlyPoint(start, cache.swaps[start]?.row, cache.earnings[start]?.row));
      }
      const latest = points.findLast(point => point.volumeRune !== null && point.incomeRune !== null);
      return sliceFinancialHourlyPayload({ points, error, stale: Boolean(error) || health?.inSync === false,
        asOf: health?.lastAggregated?.timestamp ? new Date(health.lastAggregated.timestamp * 1000).toISOString() : null,
        live: { through: latest ? new Date(latest.through * 1000).toISOString() : null, refreshMs: 60_000, intervalSeconds: 300 }
      }, range, now());
    },
    async stop() { stopped = true; controller.abort(); await active; }
  };
}
