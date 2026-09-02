import assert from 'node:assert/strict';
import test from 'node:test';
process.env.DATABASE_URL ||= 'postgresql://localhost/unused';
const { fetchAppLayerLiveStatePayload } = await import('../src/shared/app-layer-live-state.js');
const keys = ['trade', 'core', 'swap', 'index', 'base'];
const NOW = '2026-09-02T12:00:00.000Z';
const state = (changes = {}) => ({ generation: 1, last_height: 123, last_block_time: NOW,
  contiguous_blocks: 2, dirty_heights: {}, ...changes });
function previous() {
  const routeValues = Object.fromEntries(keys.map((key) => [key, []]));
  return { configs: routeValues, histories: routeValues, actions: routeValues, collector_balances: routeValues,
    collector_invalidation: state(), route_invalidation: Object.fromEntries(keys.map((key) => [key, { actions: 0, history: 0 }])),
    route_fetched_at: Object.fromEntries(['balance', 'config', 'actions', 'history'].map((type) => [type,
      Object.fromEntries(keys.map((key) => [key, NOW]))])) };
}
async function refresh(prior, invalidation) {
  const requests = [];
  const payload = await fetchAppLayerLiveStatePayload({ now: () => new Date(NOW), previousSnapshot: prior,
    collectorInvalidation: invalidation, coreSnapshot: { network: {}, pools: [] },
    fetchThorchain: async (requestPath) => { requests.push(requestPath); return { balances: [], data: { actions: [] }, entries: [] }; } });
  return { requests, payload };
}
test('healthy unchanged collector event coverage reuses action definitions and migration history', async () => {
  const prior = previous();
  prior.route_fetched_at.history = Object.fromEntries(keys.map((key) => [key, '2026-09-02T10:00:00Z']));
  const { requests } = await refresh(prior, state());
  assert.equal(requests.length, 5);
  assert.equal(requests.every((value) => value.includes('/balances/')), true);
});
test('collector migration invalidates its actions and history before their TTLs expire', async () => {
  const { requests } = await refresh(previous(), state({ dirty_heights: { trade: 124 }, last_height: 124 }));
  assert.equal(requests.filter((value) => value.endsWith('/history')).length, 1);
  assert.equal(requests.filter((value) => value.includes('/smart/')).length, 1);
});
test('unknown event coverage preserves current live action refresh cadence', async () => {
  const { requests } = await refresh(previous(), null);
  assert.equal(requests.length, 10);
});

test('gaps or stale event coverage invalidate reuse without slowing metadata freshness', async () => {
  for (const invalidation of [state({ generation: 2 }), state({ contiguous_blocks: 0 }),
    state({ last_block_time: '2026-09-02T11:55:00Z' })]) {
    const prior = previous();
    prior.route_fetched_at.history = Object.fromEntries(keys.map((key) => [key, '2026-09-02T10:00:00Z']));
    const { requests } = await refresh(prior, invalidation);
    assert.equal(requests.filter((value) => value.endsWith('/history')).length, 5);
    assert.equal(requests.filter((value) => value.includes('/smart/')).length, 5);
  }
});

test('generic Sudo and migration events invalidate collectors even without custom action events', async () => {
  const { collectorBlockInvalidation } = await import('../src/shared/app-layer-live-state.js');
  const address = 'thor1gm8q2gr25nzzsxzdp2mpja4hyvyhjlr4s6krcsgv2y953uu0js3qhwpus7';
  const event = (type, encoded = false) => ({ type, attributes: [{
    key: encoded ? Buffer.from('_contract_address').toString('base64') : '_contract_address',
    value: encoded ? Buffer.from(address).toString('base64') : address
  }] });
  const parsed = collectorBlockInvalidation({ block: { header: { height: '124', time: NOW }, data: { txs: ['a', 'b'] } },
    result_finalize_block: { events: [event('sudo')], tx_results: [
      { code: 0, events: [event('migrate', true)] }, { code: 1, events: [event('execute')] }
    ] } });
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.dirty, ['trade']);
  assert.equal(collectorBlockInvalidation({ block: { header: { height: '124', time: NOW }, data: { txs: ['a'] } },
    result_finalize_block: { events: [], tx_results: [] } }).complete, false);
  assert.equal(collectorBlockInvalidation({ block: { header: { height: '124', time: NOW } },
    result_finalize_block: { events: [] } }).complete, false);
});

test('failed metadata refresh retains its invalidation token for another attempt', async () => {
  const prior = previous();
  const changed = state({ dirty_heights: { trade: 124 }, last_height: 124 });
  const first = await fetchAppLayerLiveStatePayload({ now: () => new Date(NOW), previousSnapshot: prior,
    collectorInvalidation: changed, coreSnapshot: { network: {}, pools: [] },
    fetchThorchain: async (requestPath) => {
      if (requestPath.endsWith('/history')) throw new Error('temporary failure');
      return { balances: [], data: { actions: [] }, entries: [] };
    } });
  const { requests } = await refresh(first, changed);
  assert.equal(requests.filter((value) => value.endsWith('/history')).length, 1);
});
