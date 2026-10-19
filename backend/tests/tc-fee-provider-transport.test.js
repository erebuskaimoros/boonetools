import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCmcGlobalVolumeDays, fetchDefiLlamaDexVolumeDays } from '../src/shared/tc-fee-dash-ingestion.js';
import { acquisitionMetrics } from '../src/lib/acquisition-metrics.js';
import { requestProviderJson } from '../src/lib/provider-json.js';

test('CMC and DeFiLlama keep parsers and use bounded instrumented requests', async () => {
  acquisitionMetrics({ reset: true });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok(options.signal instanceof AbortSignal);
    return url.includes('coinmarketcap') ? Response.json({ data: { quotes: [{ timestamp: '2026-10-01', quote: { USD: { totalVolume24H: 123 } } }] } })
      : Response.json({ totalDataChart: [[1790812800, 456], [1790899200, 789]] });
  };
  const options = { fetchImpl, providerPool: false, sharedCooldown: false };
  const cmc = await fetchCmcGlobalVolumeDays('2026-10-01', 1, options);
  const dex = await fetchDefiLlamaDexVolumeDays('2026-10-01', 1, options);
  assert.equal(cmc.get('2026-10-01').cmcVolume24hUsd, 123);
  assert.equal(dex.get('2026-10-01').dexVolumeUsd, 456);
  assert.equal(dex.size, 1);
  assert.equal(calls.length, 2);
  assert.equal(acquisitionMetrics({ reset: true }).providers.reduce((sum, row) => sum + row.attempts, 0), 2);
});

test('external 429/503 responses retain Retry-After and sanitized durable cooldowns', async () => {
  for (const status of [429, 503]) {
    const writes = [], secret = 'test-cmc-secret';
    const client = { query: async (sql, values) => { writes.push({ sql, values }); return { rows: [] }; } };
    await assert.rejects(requestProviderJson('https://pro-api.coinmarketcap.com/v1/quotes', {
      providerPool: false, headers: { 'X-CMC_PRO_API_KEY': secret }, sharedCooldown: true, cooldownClient: client,
      fetchImpl: async () => new Response(`upstream echoed ${secret}`, { status, headers: { 'Retry-After': '120' } })
    }), error => error.status === status && error.retryAfterSeconds === 120 && !error.body.includes(secret));
    assert.ok(writes.some(row => row.sql.includes('insert into provider_circuit_breakers')));
    assert.ok(!JSON.stringify(writes).includes(secret));
  }
});

test('external timeout, malformed JSON and caller cancellation retain transport semantics', async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(requestProviderJson('https://api.llama.fi/overview/dexs', {
    providerPool: false, sharedCooldown: false, timeoutMs: 5, fetchImpl }), /aborted|timeout/i);
  await assert.rejects(requestProviderJson('https://api.llama.fi/overview/dexs', {
    providerPool: false, sharedCooldown: false, fetchImpl: async () => new Response('{broken') }), /JSON/i);
  const controller = new AbortController(), writes = [];
  const pending = requestProviderJson('https://api.llama.fi/overview/dexs', {
    providerPool: false, sharedCooldown: true, signal: controller.signal, fetchImpl,
    cooldownClient: { query: async (sql) => { writes.push(sql); return { rows: [] }; } } });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('collector stopped'));
  await assert.rejects(pending, error => error === controller.signal.reason);
  assert.ok(!writes.some(sql => sql.includes('insert into')));
});
