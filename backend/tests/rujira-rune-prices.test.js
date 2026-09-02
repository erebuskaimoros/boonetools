import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRujiraRunePrices } from '../src/shared/rujira-rune-prices.js';
const NOW = '2026-09-02T12:00:00Z';
const base = 'https://midgard.example.invalid/v2';
const unix = (value) => Date.parse(value) / 1000;
function fixture() {
  const stored = new Map(); const requests = [];
  return { stored, requests, options: { now: NOW, healthNow: NOW, bases: [base],
    loadCached: async (_db, _ns, key) => {
      const row = stored.get(JSON.stringify(key));
      return row && (row.completedAt || Date.parse(row.expiresAt) > Date.parse(NOW)) ? row : null;
    },
    saveCached: async (_db, row) => { stored.set(JSON.stringify(row.identity), row); },
    fetchMidgard: async (requestPath, options) => {
      requests.push(requestPath); assert.deepEqual(options.bases, [base]);
      if (requestPath === '/health') return { database: true, inSync: true,
        lastAggregated: { height: 100, timestamp: unix(NOW) } };
      const params = new URL(requestPath, base).searchParams;
      const from = Number(params.get('from')); const to = Number(params.get('to'));
      const width = params.get('interval') === 'week' ? 7 * 86400 : 86400;
      const intervals = [];
      for (let cursor = from; cursor < to; cursor += width) intervals.push({ startTime: cursor, endTime: cursor + width, runePriceUSD: '2' });
      return { intervals };
    }
  } };
}
test('closed RUNE buckets are certified once and skipped on repeated callers', async () => {
  const f = fixture();
  const first = await loadRujiraRunePrices({}, ['2026-08-31', '2026-09-01'], f.options);
  assert.equal(first.rows.length, 2); assert.equal(first.rows.every((row) => row.completed), true);
  assert.equal(f.requests[0], '/health');
  assert.equal(f.requests.length, 2);
  f.requests.length = 0;
  const second = await loadRujiraRunePrices({}, ['2026-08-31', '2026-09-01'], f.options);
  assert.equal(second.rows.length, 2); assert.equal(f.requests.length, 0);
});
test('open bucket reuse keeps its actual observation and does not claim historical finality', async () => {
  const f = fixture();
  const first = await loadRujiraRunePrices({}, ['2026-09-02'], f.options);
  assert.equal(first.rows[0].completed, false); assert.equal(f.requests.length, 1);
  const second = await loadRujiraRunePrices({}, ['2026-09-02'], f.options);
  assert.equal(second.rows[0].observedAt, first.rows[0].observedAt); assert.equal(f.requests.length, 1);
});
test('daily and weekly pricing retain separate interval identities and values', async () => {
  const f = fixture();
  await loadRujiraRunePrices({}, ['2026-08-24'], f.options);
  await loadRujiraRunePrices({}, ['2026-08-24'], { ...f.options, interval: 'week' });
  assert.equal(f.stored.size, 2);
  assert.equal(f.requests.filter((requestPath) => requestPath.includes('interval=week')).length, 1);
});
test('lagging health or missing price cannot finalize a rounded calendar bucket', async () => {
  for (const malformed of [false, true]) {
    const f = fixture(); const fetcher = f.options.fetchMidgard;
    f.options.fetchMidgard = async (requestPath, options) => {
      if (!malformed && requestPath === '/health') return { database: true, inSync: true,
        lastAggregated: { height: 1, timestamp: unix('2026-09-01T23:59:59Z') } };
      const result = await fetcher(requestPath, options);
      if (malformed && result.intervals) result.intervals[0].runePriceUSD = null;
      return result;
    };
    const result = await loadRujiraRunePrices({}, ['2026-09-01'], f.options);
    assert.equal(f.stored.size, 0); assert.equal(result.pending_buckets, 1); assert.ok(result.errors.length);
  }
});
