import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisitorSnapshot, refreshVisitorSnapshots } from '../src/shared/visitor-snapshots.js';

const observedAt = '2026-09-02T10:00:00Z';
const core = { payload: { mimir: {}, lastblock: [{ thorchain: '100' }], pools: [], network: {}, nodes: [], inbound_addresses: [], field_meta: Object.fromEntries(['mimir', 'lastblock', 'pools', 'network', 'nodes', 'inbound_addresses'].map((key) => [key, { status: 'fresh', fetched_at: observedAt }])) } };
function cachedAcquisition() {
  const entries = new Map();
  return async (_client, options) => {
    const key = options.namespace + ':' + options.identity;
    if (!entries.has(key)) entries.set(key, { payload: await options.load({}), observedAt, stale: false });
    return entries.get(key);
  };
}

test('shared vault observations are fetched once and preserve their source age', async () => {
  const calls = [];
  const options = { coreSnapshot: core, acquire: cachedAcquisition(), fetchThorchain: async (path) => { calls.push(path); return []; } };
  const first = await buildVisitorSnapshot('vault', {}, options);
  const second = await buildVisitorSnapshot('vault', {}, options);
  assert.equal(calls.length, 3); assert.equal(first.field_meta.vaults.fetched_at, observedAt);
  assert.deepEqual(second, first);
});

test('dynamic fee snapshots keep sealed and live responses distinct and share thorname detail', async () => {
  const calls = [];
  const options = { coreSnapshot: core, acquire: cachedAcquisition(), fetchThorchain: async (path) => {
    calls.push(path);
    if (path.endsWith('/dynamic_l1_fees')) return { entries: [{ thorname: 'SS' }, { thorname: 'ss' }] };
    if (path.endsWith('_current')) return { epoch: 10, entries: [] };
    return { entries: [{ epoch: 9 }] };
  } };
  const result = await buildVisitorSnapshot('dynamic-fees', {}, options);
  await buildVisitorSnapshot('dynamic-fees', {}, options);
  assert.equal(calls.length, 3); assert.equal(result.currentResponse.epoch, 10);
  assert.equal(result.detailsByThorname.ss.entries[0].epoch, 9);
});

test('cold thorname fanout preserves progress across a bounded provider-call budget', async () => {
  const calls = [];
  const options = { coreSnapshot: core, acquire: cachedAcquisition(), maxRequests: 3, fetchThorchain: async (path) => {
    calls.push(path);
    if (path.endsWith('/dynamic_l1_fees')) return { entries: ['a', 'b', 'c'].map((thorname) => ({ thorname })) };
    if (path.endsWith('_current')) return { epoch: 10, entries: [] };
    return { entries: [] };
  } };
  const first = await buildVisitorSnapshot('dynamic-fees', {}, options);
  assert.equal(calls.length, 3); assert.equal(first.pending_details, 2);
  const second = await buildVisitorSnapshot('dynamic-fees', {}, { ...options, previousSnapshot: first });
  assert.equal(calls.length, 5); assert.equal(second.pending_details, 0);
  assert.deepEqual(Object.keys(second.detailsByThorname), ['a', 'b', 'c']);
});

test('publishing a shared snapshot cannot extend its underlying live observation expiry', async () => {
  const sourceExpiry = Date.now() + 15000; let storedExpiry;
  const client = { query: async (sql, values) => {
    if (sql.includes('select * from visitor_snapshot_requests')) return { rows: [{ kind: 'dynamic-fees', snapshot_key: 'dynamic-fees', params_json: {} }] };
    if (sql.includes('insert into source_observations as current')) {
      storedExpiry = values[5];
      return { rows: [{ namespace: values[0], identity: values[1], payload_json: JSON.parse(values[2]), source: values[3], observed_at: values[4], expires_at: values[5], completed_at: values[6], metadata_json: JSON.parse(values[7]) }] };
    }
    return { rows: [] };
  } };
  await refreshVisitorSnapshots(client, { build: async () => ({ field_meta: { current: { fetched_at: new Date(Date.now() - 15000).toISOString(), expires_at: new Date(sourceExpiry).toISOString() } } }) });
  assert.ok(Date.parse(storedExpiry) <= sourceExpiry);
});
