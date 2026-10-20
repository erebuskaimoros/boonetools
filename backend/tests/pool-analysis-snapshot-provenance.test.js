import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPoolAnalysisSnapshot } from '../src/shared/pool-analysis-rolling.js';
import { ingestPoolAnalysisHistory } from '../src/shared/pool-analysis-ingestion.js';
import { loadPoolAnalysisRollingEdges, upsertPoolAnalysisDays } from '../src/shared/pool-analysis-store.js';
import { parsePoolAnalysisSwapInterval } from '../src/shared/pool-analysis.js';

const asset = 'BTC.BTC';
const cutoff = Date.parse('2026-10-20T00:30:00Z') / 1000;
const cachedRow = { asset, bucket_end: new Date(cutoff * 1000),
  volume_rune_e8: '9007199254740993', volume_usd_e2: '12345', fees_rune_e8: '23', rune_price_usd: '2' };

// Match the actual SQL write contract, not just a stubbed collector callback.
// The optional PostgreSQL companion suite also exercises the real constraint.
function persistenceFixture(row = cachedRow) {
  const writes = [];
  return { writes, async query(sql, values) {
    if (sql.includes('from pool_analysis_intraday_snapshots')) return { rows: [row] };
    if (sql.includes('insert into pool_analysis_daily')) {
      const rows = JSON.parse(values[0]);
      for (const incoming of rows) {
        if (incoming.source == null) throw new Error('null value in column "source" of relation "pool_analysis_daily" violates not-null constraint');
        assert.equal(typeof incoming.source, 'string');
        assert.notEqual(incoming.source.trim(), '');
      }
      writes.push(...rows);
      return { rowCount: rows.length };
    }
    assert.fail(`Unexpected database operation: ${sql}`);
  } };
}

test('a cached quarter-hour head keeps provenance when written back to the daily table', async () => {
  const client = persistenceFixture();
  const cached = await loadPoolAnalysisRollingEdges(client, asset, cutoff);
  await upsertPoolAnalysisDays(client, [{ ...cached.head, completed_at: null }]);
  const fresh = parsePoolAnalysisSwapInterval({ startTime: cutoff - 1800, endTime: cutoff }, { asset, partial: true });
  assert.equal(client.writes[0].source, fresh.source, 'cache reuse must retain the original swap provenance');
  assert.equal(client.writes[0].volume_rune_e8, cachedRow.volume_rune_e8);
  assert.equal(client.writes[0].partial, true);
  assert.equal(client.writes[0].completed_at, null);
});

test('the midnight zero head is persistable without fetching or inventing completed history', async () => {
  const client = persistenceFixture();
  const midnight = Date.parse('2026-10-20T00:00:00Z') / 1000;
  const snapshot = await fetchPoolAnalysisSnapshot(asset, midnight, {
    fetchMidgard: async () => assert.fail('a zero-length midnight prefix needs no upstream call'),
    onHead: async (head) => upsertPoolAnalysisDays(client, [{ ...head, completed_at: null }])
  });
  assert.equal(snapshot.cutoff, midnight);
  assert.equal(client.writes[0].volume_rune_e8, '0');
  assert.equal(client.writes[0].fees_rune_e8, '0');
  assert.equal(client.writes[0].interval_start, '2026-10-20T00:00:00.000Z');
  assert.equal(client.writes[0].interval_end, client.writes[0].interval_start);
  assert.equal(client.writes[0].partial, true);
  assert.equal(client.writes[0].completed_at, null);
});

test('same-window collection reuses cached amounts without marking a successful pool stale', async () => {
  const client = persistenceFixture();
  const now = '2026-10-20T00:31:00Z';
  const requests = [], failures = [], published = [], states = [];
  const result = await ingestPoolAnalysisHistory(client, {
    now, healthNow: now, assets: [asset], rolling: true, historyRequestLimit: 0,
    coreSnapshot: { payload: {
      field_meta: { pools: { status: 'fresh', fetched_at: now } },
      pools: [{ asset, status: 'available', balance_rune: '100000000', balance_asset: '100000000', asset_tor_price: '200000000' }]
    } },
    fetchMidgard: async (route) => {
      requests.push(route);
      assert.equal(route, '/health', 'the saved prefix must not be fetched again');
      return { database: true, inSync: true, lastAggregated: { height: 28000000, timestamp: cutoff + 20 } };
    },
    saveIntradaySnapshot: async () => {}, upsertDepths: async () => 1,
    loadPendingDays: async () => [], loadCompletedDays: async () => [], loadBoundarySnapshots: async () => [],
    markRollingFailure: async (_client, _asset, message) => failures.push(message),
    saveRollingSnapshot: async (_client, _asset, periods) => published.push(periods),
    updateSyncState: async (_client, state) => states.push(state)
  });
  assert.equal(result.failed_pools, 0, failures.join('; '));
  assert.equal(result.successful_pools, 1);
  assert.equal(result.swap_pages, 0);
  assert.deepEqual(requests, ['/health']);
  assert.deepEqual(failures, []);
  assert.equal(published.length, 1);
  assert.equal(states[0].lastError, '');
});
