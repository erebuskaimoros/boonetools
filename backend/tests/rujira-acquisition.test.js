import assert from 'node:assert/strict';
import test from 'node:test';
process.env.DATABASE_URL ||= 'postgresql://localhost/unused';
process.env.DUNE_API_KEY = 'test-only';
const { ingestRujiraReservePaymentScheduledCandidates, processRujiraReservePaymentBlocks,
  runRujiraReservePaymentsIngestion, refreshRujiraReservePaymentPrices } = await import('../src/shared/rujira-reserve-payments.js');
const { refreshRujiraBaseFeePrices } = await import('../src/shared/rujira-base-fees.js');
function response(payload) { return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) }; }

test('Reserve scheduling reuses a fresh durable head instead of requesting RPC status', async () => {
  let statusRequests = 0;
  const result = await ingestRujiraReservePaymentScheduledCandidates({ query: async () => ({ rows: [], rowCount: 0 }) }, {
    resolveHead: async () => ({ height: 27600000, source: 'chain-block-headers' }),
    fetchLatestHeight: async () => { statusRequests++; return 27600000; },
    fetchSchedule: async () => ({ height: 27600001, cadence: 101 })
  });
  assert.equal(result.latest_height, 27600000);
  assert.equal(statusRequests, 0);
});

test('Reserve block acquisition reuses the exact locally stored timestamp', async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url).includes('/block?')) return response({ result: { block: { header: { time: '2026-09-01T12:00:00Z' } } } });
    return response({ result: { height: '27600000', txs_results: [], finalize_block_events: [] } });
  };
  try {
    const client = { query: async (sql) => ({ rows: sql.includes("where status = 'pending'")
      ? [{ height: 27600000, block_time: null, source: 'scheduled-cadence', attempts: 0 }] : [], rowCount: 0 }) };
    await processRujiraReservePaymentBlocks(client, { limit: 1,
      resolveBlockTime: async () => '2026-09-01T12:00:00.000Z' });
    assert.equal(requests.filter((url) => url.includes('/block?')).length, 0);
    assert.equal(requests.filter((url) => url.includes('/block_results?')).length, 1);
  } finally { globalThis.fetch = original; }
});

test('Reserve and Base Fee prices use completed buckets before making another provider request', async () => {
  const original = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => { externalCalls++; return response({ intervals: [] }); };
  try {
    const client = { query: async (sql) => ({ rows: sql.includes('select min(block_time)')
      ? [{ min_time: '2026-08-01T00:00:00Z', max_time: '2026-08-01T12:00:00Z' }]
      : sql.includes('distinct') ? [{ day: '2026-08-01', bucket_start: '2026-08-01' }] : [], rowCount: 0 }) };
    const options = { loadPrices: async () => [{ start: '2026-08-01', end: '2026-08-02', price: 2, completed: true }] };
    await refreshRujiraReservePaymentPrices(client, options);
    await refreshRujiraBaseFeePrices(client, options);
    assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = original; }
});
