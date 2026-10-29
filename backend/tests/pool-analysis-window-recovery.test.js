import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestPoolAnalysisHistory } from '../src/shared/pool-analysis-ingestion.js';

// Oct 28 ZEC incident: the prior day's 23:45 and midnight polls were both
// absent. Requiring both adjacent samples left 24H showing $438.73 yesterday
// instead of roughly $1,025 earned in the requested trailing window.
const asset = 'ZEC.ZEC';
const cutoff = Date.parse('2026-10-28T23:45:00Z') / 1000;
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const closedDay = {
  asset, day: '2026-10-27', partial: false, completed_at: '2026-10-28T00:47:00Z',
  volume_rune_e8: '67891292026563', volume_usd_e2: '42923336',
  fees_rune_e8: '69554048925', rune_price_usd: '0.6307812665111794'
};
const current = {
  totalVolume: '124309444306456', totalVolumeUSD: '78247707',
  totalFees: '158367067902', runePriceUSD: '0.6284688716364757'
};
const boundary = {
  totalVolume: '63390711031489', totalVolumeUSD: '40072449',
  totalFees: '64768613385', runePriceUSD: '0.6307812665111794'
};

function fixture({ failRecovery = false, daily = [closedDay] } = {}) {
  const snapshots = [{ bucket_end: '2026-10-27T23:30:00Z',
    volume_rune_e8: '58253303402865', volume_usd_e2: '36822229',
    fees_rune_e8: '56382813739', rune_price_usd: '0.63' }];
  const requests = [];
  let published;
  const options = {
    rolling: true, assets: [asset], now: iso(cutoff + 120), healthNow: iso(cutoff + 120),
    coreSnapshot: null, historyRequestLimit: 0,
    loadPendingDays: async () => [], loadCompletedDays: async () => daily,
    loadBoundarySnapshots: async () => [...snapshots],
    loadRollingEdges: async () => {
      const head = snapshots.find((row) => row.bucket_end === iso(cutoff));
      return head ? { asset, cutoff, head } : null;
    },
    saveIntradaySnapshot: async (_client, head) => snapshots.push({ ...head, bucket_end: head.interval_end }),
    saveRollingSnapshot: async (_client, _asset, periods) => { published = periods; },
    upsert: async (_client, rows) => rows.length, updateSyncState: async () => {},
    markRollingFailure: async () => assert.fail('A boundary failure must still publish the labelled fallback'),
    fetchMidgard: async (route) => {
      if (route === '/health') return { database: true, inSync: true,
        lastAggregated: { height: 1, timestamp: cutoff } };
      requests.push(route);
      const query = new URL(route, 'https://fixture.invalid').searchParams;
      const to = Number(query.get('to'));
      assert.equal(query.get('pool'), asset);
      assert.equal(query.has('interval'), false, 'Fetch only the exact prefix, not a daily history scan');
      assert.equal(query.has('count'), false);
      assert.ok([cutoff, cutoff - 86400].includes(to), 'Only the current head and required 24H boundary may be fetched');
      assert.equal(Number(query.get('from')), Math.floor(to / 86400) * 86400);
      if (to !== cutoff && failRecovery) throw new Error('Source unavailable');
      return { meta: { startTime: query.get('from'), endTime: String(to),
        ...(to === cutoff ? current : boundary) } };
    }
  };
  return { options, requests, snapshots, metric: () => published.find((row) => row.period_id === '24h') };
}

test('ZEC multi-poll outage recovers only the required 24H boundary and durably reuses it', async () => {
  const f = fixture();
  await ingestPoolAnalysisHistory({}, f.options);
  assert.equal(f.metric().window_mode, 'rolling');
  assert.equal(f.metric().snapshot_ready, true);
  assert.equal(f.metric().window_start, iso(cutoff - 86400));
  assert.equal(f.metric().window_end, iso(cutoff));
  assert.equal(f.metric().fees_rune_e8, '163152503442');
  assert.equal(f.metric().volume_usd, 810985.94);
  assert.ok(f.metric().fees_usd > 1025 && f.metric().fees_usd < 1026);
  assert.equal(f.requests.length, 2);
  await ingestPoolAnalysisHistory({}, f.options);
  assert.equal(f.requests.length, 2, 'The next run must reuse the saved head and repaired boundary');
  assert.equal(f.metric().window_mode, 'rolling');
});

test('unavailable recovery retains explicit completed-day bounds and never invents a boundary', async () => {
  const f = fixture({ failRecovery: true });
  await ingestPoolAnalysisHistory({}, f.options);
  assert.equal(f.requests.length, 2, 'Recovery must be attempted even when several adjacent polls are missing');
  assert.equal(f.metric().window_mode, 'completed-days');
  assert.equal(f.metric().snapshot_ready, false);
  assert.equal(f.metric().window_start, '2026-10-27T00:00:00.000Z');
  assert.equal(f.metric().window_end, '2026-10-28T00:00:00.000Z');
  assert.equal(f.metric().fees_rune_e8, closedDay.fees_rune_e8);
  assert.equal(f.snapshots.some((row) => row.bucket_end === iso(cutoff - 86400)), false);
});

test('a missing completed starting day cannot be repaired with a prefix alone', async () => {
  const f = fixture({ daily: [] });
  await ingestPoolAnalysisHistory({}, f.options);
  assert.equal(f.requests.length, 1);
  assert.equal(f.metric().snapshot_ready, false);
  assert.equal(f.metric().fees_rune_e8, null);
});

test('a cold prefix ledger still recovers 24H when its completed starting day is available', async () => {
  const f = fixture();
  f.snapshots.length = 0;
  await ingestPoolAnalysisHistory({}, f.options);
  assert.equal(f.requests.length, 2);
  assert.equal(f.metric().fees_rune_e8, '163152503442');
  assert.equal(f.metric().window_mode, 'rolling');
});

test('unsealed or invalid completed days do not trigger futile prefix recovery', async () => {
  for (const changes of [
    { partial: true }, { completed_at: null }, { fees_rune_e8: null }, { rune_price_usd: '0' }
  ]) {
    const f = fixture({ daily: [{ ...closedDay, ...changes }] });
    await ingestPoolAnalysisHistory({}, f.options);
    assert.equal(f.requests.length, 1);
    assert.equal(f.metric().snapshot_ready, false);
  }
});

test('invalid bounds or impossible prefix amounts are not persisted as durable repairs', async () => {
  for (const changes of [
    { endTime: String(cutoff - 86400 + 1) },
    { totalFees: String(BigInt(closedDay.fees_rune_e8) + 1n) },
    { totalVolume: String(BigInt(closedDay.volume_rune_e8) + 1n) },
    { totalVolumeUSD: String(BigInt(closedDay.volume_usd_e2) + 1n) }
  ]) {
    const f = fixture();
    const fetch = f.options.fetchMidgard;
    f.options.fetchMidgard = async (route) => {
      const response = await fetch(route);
      if (Number(response.meta?.endTime) === cutoff - 86400) Object.assign(response.meta, changes);
      return response;
    };
    await ingestPoolAnalysisHistory({}, f.options);
    assert.equal(f.requests.length, 2);
    assert.equal(f.metric().snapshot_ready, false);
    assert.equal(f.metric().fees_rune_e8, closedDay.fees_rune_e8);
    assert.equal(f.snapshots.some((row) => row.bucket_end === iso(cutoff - 86400)), false);
  }
});

test('a recovery rate limit stops later repairs while all live heads and fallback totals publish', async () => {
  const f = fixture();
  const requests = [], published = new Map();
  await ingestPoolAnalysisHistory({}, {
    ...f.options, assets: ['XRP.XRP', asset], concurrency: 1,
    loadRollingEdges: async () => null,
    saveRollingSnapshot: async (_client, pool, periods) => published.set(pool, periods[0]),
    fetchMidgard: async (route) => {
      if (route === '/health') return { database: true, inSync: true,
        lastAggregated: { height: 1, timestamp: cutoff } };
      const query = new URL(route, 'https://fixture.invalid').searchParams;
      const to = Number(query.get('to'));
      requests.push({ pool: query.get('pool'), to });
      if (to !== cutoff) throw Object.assign(new Error('HTTP 429'), { status: 429 });
      return { meta: { startTime: query.get('from'), endTime: String(to), ...current } };
    }
  });
  assert.deepEqual(requests, [
    { pool: 'XRP.XRP', to: cutoff }, { pool: asset, to: cutoff },
    { pool: 'XRP.XRP', to: cutoff - 86400 }
  ]);
  assert.equal(published.size, 2);
  for (const row of published.values()) {
    assert.equal(row.snapshot_ready, false);
    assert.equal(row.fees_rune_e8, closedDay.fees_rune_e8);
  }
});
