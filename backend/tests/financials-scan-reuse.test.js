import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinancialsProviderRequest } from '../src/jobs/financials.js';

const at = Date.parse('2026-10-29T12:00:00Z');
const scan = '/actions?type=swap&limit=50&timestamp=1793275200';
const page = () => ({ actions: [{ type: 'swap', status: 'pending', date: '1793275199000000000' }],
  meta: { nextPageToken: 'opaque-next-page' } });

test('overlapping UTC and local-day scans reuse the identical recent action page', async () => {
  let clock = at, calls = 0;
  const request = createFinancialsProviderRequest({}, { now: () => clock,
    transport: async () => { calls++; return page(); } });
  const utc = await request(scan, { lane: 'day-details', midgardBudgetClass: 'bulk' });
  utc.actions[0].status = 'caller-mutated';
  clock += 5000;
  const local = await request(scan, { lane: 'day-details', midgardBudgetClass: 'bulk' });
  assert.equal(local.actions[0].status, 'pending', 'callers must not share mutable response objects');
  assert.equal(calls, 1, 'the same page should not cost another provider request for another calendar window');
  clock = at + 60000;
  await request(scan, { lane: 'day-details', midgardBudgetClass: 'bulk' });
  assert.equal(calls, 2, 'pending action data may only be reused for sixty seconds');
});

test('concurrent identical scan pages coalesce but transaction verification never reuses a scan cache', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const request = createFinancialsProviderRequest({}, { now: () => at,
    transport: async () => { calls++; await gate; return page(); } });
  const first = request(scan), second = request(scan);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  const verification = `/actions?txid=${'A'.repeat(64)}&limit=50`;
  await request(verification, { midgardBudgetClass: 'verification' });
  await request(verification, { midgardBudgetClass: 'verification' });
  assert.equal(calls, 3, 'saved-ID checks keep their existing settlement and backoff semantics');
});

test('different snapshot bounds and opaque cursors always stay separate', async () => {
  const routes = [];
  const request = createFinancialsProviderRequest({}, { now: () => at,
    transport: async options => { routes.push(options.path); return page(); } });
  const pages = [scan, scan.replace('1793275200','1793276100'),
    '/actions?type=swap&limit=50&nextPageToken=first',
    '/actions?type=swap&limit=50&nextPageToken=second'];
  for (const route of pages) await request(route);
  assert.deepEqual(routes, pages);
});

test('only canonical bounded swap scans are cached, independently of query ordering', async () => {
  let calls = 0;
  const request = createFinancialsProviderRequest({}, { now: () => at,
    transport: async () => { calls++; return page(); } });
  await request(scan); await request('/actions?timestamp=1793275200&limit=50&type=swap');
  assert.equal(calls, 1);
  const excluded = [scan + '&address=test', scan + '&type=swap', scan.replace('limit=50', 'limit=49'),
    scan.replace('type=swap', 'type=refund'), scan.replace('timestamp=1793275200', 'timestamp=bad'),
    '/actions?type=swap&limit=50', scan + '&nextPageToken=cursor'];
  for (const route of excluded) { await request(route); await request(route); }
  assert.equal(calls, 1 + excluded.length * 2);
  await request(scan, { service: 'rpc' }); await request(scan, { service: 'rpc' });
  assert.equal(calls, 3 + excluded.length * 2);
});

test('failures and invalid scan pages are not retained', async () => {
  for (const invalid of [{}, { actions: 'invalid' }, { actions: [{ type: 'refund', date: '1' }] },
    { actions: [{ type: 'swap', date: 'bad' }] },
    { actions: [{ type: 'swap', date: '1' }, { type: 'swap', date: '2' }] },
    { ...page(), meta: { nextPageToken: 123 } }]) {
    let calls = 0;
    const request = createFinancialsProviderRequest({}, { now: () => at,
      transport: async () => { calls++; return calls === 1 ? invalid : page(); } });
    assert.deepEqual(await request(scan), invalid);
    await request(scan); assert.equal(calls, 2);
  }
  let calls = 0;
  const request = createFinancialsProviderRequest({}, { now: () => at,
    transport: async () => { calls++; if (calls === 1) throw new Error('temporary'); return page(); } });
  await assert.rejects(request(scan), /temporary/);
  await request(scan); assert.equal(calls, 2);
});

test('scan memory is capped at sixty-four entries and oversized responses are never retained', async () => {
  let calls = 0;
  const request = createFinancialsProviderRequest({}, { now: () => at,
    transport: async () => { calls++; return page(); } });
  for (let i = 0; i < 65; i++) await request(`/actions?type=swap&limit=50&nextPageToken=page-${i}`);
  await request('/actions?type=swap&limit=50&nextPageToken=page-64'); assert.equal(calls, 65);
  await request('/actions?type=swap&limit=50&nextPageToken=page-0'); assert.equal(calls, 66);
  let largeCalls = 0;
  const large = createFinancialsProviderRequest({}, { now: () => at,
    transport: async () => { largeCalls++; return { ...page(), padding: 'x'.repeat(8 * 1024 * 1024) }; } });
  await large(scan); await large(scan); assert.equal(largeCalls, 2);
});

test('aggregate scan bytes are bounded and rollback expires observations', async () => {
  let clock = at, calls = 0;
  const request = createFinancialsProviderRequest({}, { now: () => clock,
    transport: async () => { calls++; return { ...page(), padding: 'x'.repeat(3 * 1024 * 1024) }; } });
  for (const cursor of ['one', 'two', 'three']) await request(`/actions?type=swap&limit=50&nextPageToken=${cursor}`);
  await request('/actions?type=swap&limit=50&nextPageToken=three'); assert.equal(calls, 3);
  await request('/actions?type=swap&limit=50&nextPageToken=one'); assert.equal(calls, 4, 'oldest page evicted to stay under 8MiB');
  clock--; await request('/actions?type=swap&limit=50&nextPageToken=one'); assert.equal(calls, 5);
});

test('scan cancellation does not cache aborted work or let a joining caller cancel its peer', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const request = createFinancialsProviderRequest({}, { now: () => at,
    transport: async () => { calls++; await gate; return page(); } });
  const owner = request(scan), controller = new AbortController();
  const joined = request(scan, { signal: controller.signal });
  controller.abort(); await assert.rejects(joined, { name: 'AbortError' });
  release(); await owner; await request(scan); assert.equal(calls, 1);
  await assert.rejects(async () => request(scan, { signal: controller.signal }), { name: 'AbortError' });
});
