import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPoolAnalysisReadModel } from '../src/shared/pool-analysis.js';

test('Pool Analysis period aggregates include the current UTC day instead of stopping yesterday', async () => {
  const now = new Date('2026-09-05T12:00:00Z');
  let aggregationThrough;
  const result = await buildPoolAnalysisReadModel({}, {
    now,
    getCoreSnapshot: async () => ({
      payload: {
        pools: [{ asset: 'BTC.BTC', status: 'Available', balance_rune: '100000000', balance_asset: '100000000' }],
        oracle_prices: { prices: [{ symbol: 'RUNE', price: '1' }] },
        field_meta: { pools: { status: 'fresh' }, oracle_prices: { status: 'fresh' } }
      }
    }),
    loadAggregates: async (_client, through) => { aggregationThrough = through; return []; },
    loadSyncStates: async () => []
  });
  assert.equal(new Date(aggregationThrough).toISOString().slice(0, 10), '2026-09-05');
  assert.equal(result.payload.period.through_day, '2026-09-05');
});

const rolling = await import('../src/shared/pool-analysis-rolling.js');
const asset = 'BTC.BTC';
const cutoff = Date.parse('2026-09-05T12:15:00Z') / 1000;
const amounts = (amount = '9007199254740993') => ({ volume_rune_e8: amount, volume_usd_e2: '100', fees_rune_e8: '3', rune_price_usd: '2' });
const interval = (from, to) => ({ startTime: String(from), endTime: String(to), totalVolume: '9007199254740993', totalVolumeUSD: '100', totalFees: '3', runePriceUSD: '2' });
const fetcher = async (request) => { const url = new URL(request, 'https://midgard.invalid'); return { intervals: [], meta: interval(Number(url.searchParams.get('from')), Number(url.searchParams.get('to'))) }; };
const completed = (day, changes = {}) => ({ day, ...amounts(), partial: false, completed_at: '2026-09-05T00:00:00Z', ...changes });

test('current prefix floors the source watermark to a quarterhour and never requests old boundaries', async () => {
  const calls = [];
  const result = await rolling.fetchPoolAnalysisSnapshot(asset, cutoff + 899, { fetchMidgard: async (route) => { calls.push(route); return fetcher(route); } });
  assert.equal(calls.length, 1);
  assert.equal(result.cutoff, cutoff);
  assert.equal(result.head.interval_start, '2026-09-05T00:00:00.000Z');
  assert.equal(result.head.interval_end, '2026-09-05T12:15:00.000Z');
  assert.doesNotMatch(calls[0], /interval=|count=/);
});

test('unaligned or malformed source bounds are rejected', async () => {
  await assert.rejects(rolling.fetchPoolAnalysisSnapshot(asset, cutoff, {
    fetchMidgard: async () => ({ meta: interval(cutoff - 1, cutoff), intervals: [] })
  }), /bounds/);
});

test('exact rolling quarterhour uses completed-day minus recorded prefix plus current prefix, with bigint totals', async () => {
  const sample = await rolling.fetchPoolAnalysisSnapshot(asset, cutoff, { fetchMidgard: fetcher });
  const daily = [completed('2026-09-04', { fees_rune_e8: '10' })];
  const prefixes = [{ bucket_end: '2026-09-04T12:15:00Z', ...amounts('1'), fees_rune_e8: '2', rune_price_usd: '100000' }];
  const metric = rolling.combinePoolAnalysisSnapshots(sample, daily, prefixes)[0];
  assert.equal(metric.volume_rune_e8, '18014398509481985');
  assert.equal(metric.fees_rune_e8, '11');
  assert.equal(metric.fees_usd, 22 / 1e8, 'remaining starting-day RUNE fees use the completed-day mean price');
  assert.equal(metric.snapshot_ready, true);
  assert.equal(metric.window_mode, 'rolling');
  assert.equal(metric.window_start, '2026-09-04T12:15:00.000Z');
});

test('missing boundary poll falls back to labelled completed days without interpolating a nearby poll', async () => {
  const sample = await rolling.fetchPoolAnalysisSnapshot(asset, cutoff, { fetchMidgard: fetcher });
  const daily = [completed('2026-09-04')];
  const prefixes = [{ bucket_end: '2026-09-04T12:00:00Z', ...amounts() }];
  const metric = rolling.combinePoolAnalysisSnapshots(sample, daily, prefixes)[0];
  assert.equal(metric.volume_rune_e8, '9007199254740993');
  assert.equal(metric.window_mode, 'completed-days');
  assert.equal(metric.snapshot_ready, false);
  assert.equal(metric.window_start, '2026-09-04T00:00:00.000Z');
  assert.equal(metric.window_end, '2026-09-05T00:00:00.000Z');
  assert.equal(rolling.combinePoolAnalysisSnapshots(sample, [], prefixes)[0].volume_rune_e8, null);
});

test('a missed XRP 24h boundary is fetched exactly so the table includes live fees', async () => {
  const { ingestPoolAnalysisHistory } = await import('../src/shared/pool-analysis-ingestion.js');
  const xrp = 'XRP.XRP';
  const liveCutoff = Date.parse('2026-09-17T19:15:00Z') / 1000;
  const boundary = liveCutoff - 86400;
  const snapshots = [
    { bucket_end: '2026-09-16T19:00:00.000Z', volume_rune_e8: '38000000000000', volume_usd_e2: '18000000', fees_rune_e8: '39246216223', rune_price_usd: '0.49' },
    { bucket_end: '2026-09-16T19:30:00.000Z', volume_rune_e8: '40000000000000', volume_usd_e2: '20000000', fees_rune_e8: '39816129197', rune_price_usd: '0.49' }
  ];
  const swapRequests = [];
  let published;
  await ingestPoolAnalysisHistory({}, {
    rolling: true,
    assets: [xrp],
    now: '2026-09-17T19:18:00Z',
    coreSnapshot: null,
    loadPendingDays: async () => [],
    loadCompletedDays: async () => [completed('2026-09-16', {
      volume_rune_e8: '43555344897273', volume_usd_e2: '21413928',
      fees_rune_e8: '44243401899', rune_price_usd: '0.4932330155821272',
      completed_at: '2026-09-17T00:45:23Z'
    })],
    loadBoundarySnapshots: async () => snapshots,
    loadRollingEdges: async () => null,
    saveIntradaySnapshot: async (_client, head) => snapshots.push({
      bucket_end: head.interval_end,
      volume_rune_e8: head.volume_rune_e8,
      volume_usd_e2: head.volume_usd_e2,
      fees_rune_e8: head.fees_rune_e8,
      rune_price_usd: head.rune_price_usd
    }),
    saveRollingSnapshot: async (_client, _asset, periods) => { published = periods; },
    upsert: async (_client, rows) => rows.length,
    updateSyncState: async () => {},
    fetchMidgard: async (route) => {
      if (route === '/health') return { database: true, inSync: true, lastAggregated: { height: 1, timestamp: liveCutoff } };
      swapRequests.push(route);
      const url = new URL(route, 'https://midgard.invalid');
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      assert.equal(url.searchParams.get('pool'), xrp);
      assert.equal(url.searchParams.has('interval'), false);
      assert.equal(url.searchParams.has('count'), false);
      if (to === liveCutoff) return { meta: {
        startTime: String(from), endTime: String(to), totalVolume: '678710530995116',
        totalVolumeUSD: '342884835', totalFees: '854602573066', runePriceUSD: '0.5005047762777458'
      } };
      assert.equal(to, boundary);
      return { meta: {
        startTime: String(from), endTime: String(to), totalVolume: '38938978892801',
        totalVolumeUSD: '19139894', totalFees: '39576896837', runePriceUSD: '0.4868645060115576'
      } };
    }
  });
  assert.equal(swapRequests.length, 2, 'one live prefix and one exact missing boundary');
  assert.equal(snapshots.some((row) => row.bucket_end === '2026-09-16T19:15:00.000Z'), true);
  const metric = published.find((period) => period.period_id === '24h');
  assert.equal(metric.window_mode, 'rolling');
  assert.equal(metric.snapshot_ready, true);
  assert.equal(metric.window_start, '2026-09-16T19:15:00.000Z');
  assert.equal(metric.fees_rune_e8, '859269078128');
  assert.ok(metric.fees_usd > 4200 && metric.fees_usd < 4400);
});

test('boundary lookup includes only 24h adjacent samples needed to prove an isolated gap', async () => {
  const { loadPoolAnalysisBoundarySnapshots } = await import('../src/shared/pool-analysis-store.js');
  let queryParams;
  await loadPoolAnalysisBoundarySnapshots({ query: async (_sql, params) => {
    queryParams = params;
    return { rows: [] };
  } }, asset, cutoff, [{ id: '24h', days: 1 }, { id: '7d', days: 7 }]);
  assert.equal(queryParams[0], asset);
  assert.deepEqual(queryParams[1], [
    '2026-09-04T12:00:00.000Z',
    '2026-09-04T12:15:00.000Z',
    '2026-09-04T12:30:00.000Z',
    '2026-08-29T12:15:00.000Z'
  ]);
});

test('midnight uses complete days without zero-length queries or a cross-day cumulative delta', async () => {
  const midnight = Date.parse('2026-09-06T00:00:00Z') / 1000;
  const sample = await rolling.fetchPoolAnalysisSnapshot(asset, midnight, { fetchMidgard: async () => assert.fail('No query at midnight') });
  const metric = rolling.combinePoolAnalysisSnapshots(sample, [completed('2026-09-05')])[0];
  assert.equal(metric.volume_rune_e8, '9007199254740993');
  assert.equal(metric.snapshot_ready, true);
  assert.equal(metric.window_start, '2026-09-05T00:00:00.000Z');
});

test('regressing historical cumulative amounts do not produce negative rolling values', async () => {
  const sample = await rolling.fetchPoolAnalysisSnapshot(asset, cutoff, { fetchMidgard: fetcher });
  const metric = rolling.combinePoolAnalysisSnapshots(sample, [completed('2026-09-04')],
    [{ bucket_end: '2026-09-04T12:15:00Z', ...amounts('9999999999999999999') }])[0];
  assert.equal(metric.window_mode, 'completed-days');
  assert.equal(metric.volume_rune_e8, '9007199254740993');
});

test('HTTP response ages rolling timestamps but does not call labelled completed-day fallbacks stale', async () => {
  const { handlePoolAnalysis } = await import('../src/handlers/pool-analysis.js');
  const getReadModel = async () => ({ stale: false, payload: { period: { mode: 'bucketed' }, pools: [{ asset,
    period_metrics: { '24h': { window_mode: 'rolling', window_end: '2026-09-05T12:00:00Z', stale: false },
      '7d': { window_mode: 'completed-days', window_end: '2026-09-05T00:00:00Z', stale: false } } }] } });
  const response = await handlePoolAnalysis(null, null, { getReadModel, now: '2026-09-05T12:26:00Z' });
  assert.equal(response.body.pools[0].period_metrics['24h'].stale, true);
  assert.equal(response.body.pools[0].period_metrics['7d'].stale, false);
});

test('ingestion reuses durable same-quarter sample, makes one source call, and retains successful aggregate on failure', async () => {
  const { ingestPoolAnalysisHistory } = await import('../src/shared/pool-analysis-ingestion.js');
  let watermark = cutoff;
  let saved;
  let published;
  let calls = 0;
  let error;
  const options = { rolling: true, assets: [asset], now: '2026-09-05T12:40:00Z', healthNow: '2026-09-05T12:40:00Z', coreSnapshot: null,
    loadPendingDays: async () => [], loadCompletedDays: async () => [completed('2026-09-04')], loadBoundarySnapshots: async () => [],
    loadRollingEdges: async (_client, _asset, end) => saved?.cutoff === end ? saved : null,
    saveIntradaySnapshot: async (client, head) => { saved = { asset, cutoff: Date.parse(head.interval_end) / 1000, head }; },
    saveRollingSnapshot: async (_client, _asset, periods) => { published = periods; }, markRollingFailure: async (_client, _asset, message) => { error = message; },
    upsert: async (_client, rows) => rows.length, updateSyncState: async () => {},
    fetchSwapHistory: async () => assert.fail('No duplicate live-day query'),
    fetchMidgard: async (route) => {
      if (route === '/health') return { database: true, inSync: true, lastAggregated: { height: 1, timestamp: watermark } };
      calls++;
      if (watermark > cutoff + 899) throw new Error('Upstream unavailable');
      return fetcher(route);
    } };
  await ingestPoolAnalysisHistory({}, options);
  assert.equal(calls, 1);
  assert.equal(published.find((period) => period.period_id === '24h').window_mode, 'completed-days',
    'a cold ledger must not repeatedly fetch yesterday on every live poll');
  watermark += 100;
  await ingestPoolAnalysisHistory({}, options);
  assert.equal(calls, 1);
  const previous = published;
  watermark += 900;
  await ingestPoolAnalysisHistory({}, options);
  assert.equal(calls, 2);
  assert.equal(published, previous);
  assert.match(error, /Upstream unavailable/);
});

test('legacy complete-day fallback keeps original totals for valid unsealed daily rows', async () => {
  const { loadPoolAnalysisRollingAggregates } = await import('../src/shared/pool-analysis-store.js');
  const calls = [];
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    return sql.includes('from source_observations') ? { rows: [] } : { rows: [{ asset, period_id: '24h', period_days: 1,
      observed_days: 1, volume_rune_e8: '9007199254740993', fees_rune_e8: '3', volume_usd: '1', fees_usd: '0.00000006' }] };
  } };
  const rows = await loadPoolAnalysisRollingAggregates(client, '2026-09-05T12:15:00Z', [{ id: '24h', days: 1 }]);
  assert.equal(rows[0].volume_rune_e8, '9007199254740993');
  assert.equal(rows[0].window_mode, 'completed-days');
  assert.equal(rows[0].snapshot_ready, false);
  assert.equal(rows[0].incomplete, false);
  assert.equal(calls[1].params[0], '2026-09-04');
  assert.doesNotMatch(calls[1].sql, /completed_at/);
});
