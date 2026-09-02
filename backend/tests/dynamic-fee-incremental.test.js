import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshAffiliateRange, affiliateActionIdentity } from '../src/shared/dynamic-fee-affiliate-ingestion.js';

const from = Date.parse('2026-08-01T00:00:00Z') / 1000;
const action = (id, date = from + 60) => ({ date: String(BigInt(date) * 1000000000n), height: '10', status: 'success', in: [{ txID: id, coins: [{ amount: '100000000', asset: 'BTC.BTC' }] }], pools: ['BTC.BTC', 'ETH.ETH'], metadata: { swap: { inPriceUSD: '2' } } });
function fixture() {
  const actions = new Map(); const ranges = [];
  const job = { affiliate: 'ss', scan_from: from, scan_to: from + 86400, page_token: '', scan_watermark: from + 3 * 86400, source_base: 'test-provider' };
  return { actions, ranges, job, options: {
    nowMs: (from + 4 * 86400) * 1000,
    savePage: async (_client, state, page, token) => { for (const item of page) actions.set(affiliateActionIdentity(item), item); job.page_token = token; },
    loadActions: async () => [...actions.values()],
    finishRange: async (_client, state, points) => { ranges.push(points); job.page_token = ''; }
  } };
}

test('affiliate scan saves each successful page and resumes after failure without rescanning', async () => {
  const f = fixture(); const calls = [];
  await assert.rejects(refreshAffiliateRange({}, f.job, { ...f.options, maxPages: 2, fetchActions: async (params) => {
    calls.push(params); if (params.prevPageToken) throw new Error('rate limited');
    return { actions: [action('abc')], meta: { prevPageToken: 'next' } };
  } }), /rate limited/);
  assert.equal(f.actions.size, 1); assert.equal(f.job.page_token, 'next'); assert.equal(f.ranges.length, 0);
  const result = await refreshAffiliateRange({}, f.job, { ...f.options, maxPages: 2, fetchActions: async (params) => {
    calls.push(params); return params.prevPageToken === 'last' ? { actions: [], meta: {} }
      : { actions: [action('ABC'), action('def', from + 120)], meta: { prevPageToken: 'last' } };
  } });
  assert.equal(calls[2].prevPageToken, 'next'); assert.equal(result.complete, true);
  assert.equal(f.ranges[0][0].routeCount, 2); assert.equal(f.ranges[0][0].legVolumeUsd, 8);
  assert.ok(f.ranges[0][0].completed_at);
});

test('page budget preserves progress without certifying a partially scanned day', async () => {
  const f = fixture();
  const result = await refreshAffiliateRange({}, f.job, { ...f.options, maxPages: 1, fetchActions: async () => ({ actions: [action('one')], meta: { prevPageToken: 'next' } }) });
  assert.equal(result.complete, false); assert.equal(f.job.page_token, 'next'); assert.equal(f.ranges.length, 0);
});

test('pending actions and source watermark lag keep closed-looking days incomplete', async () => {
  const f = fixture(); f.job.scan_watermark = from + 3600;
  await refreshAffiliateRange({}, f.job, { ...f.options, fetchActions: async (params) => params.prevPageToken ? { actions: [], meta: {} }
    : { actions: [{ ...action('one'), status: 'pending' }], meta: { prevPageToken: 'last' } } });
  assert.equal(f.ranges[0][0].completed_at, null);
});

test('a successful action without a usable historical input price cannot seal a day', async () => {
  const f = fixture();
  await refreshAffiliateRange({}, f.job, { ...f.options, fetchActions: async (params) => params.prevPageToken ? { actions: [], meta: {} }
    : { actions: [{ ...action('one'), metadata: { swap: {} } }], meta: { prevPageToken: 'last' } } });
  assert.equal(f.ranges[0][0].completed_at, null);
});

test('exclusive Midgard lower bound still includes actions exactly at UTC midnight', async () => {
  const f = fixture(); const calls = [];
  await refreshAffiliateRange({}, f.job, { ...f.options, fetchActions: async (params) => {
    calls.push(params);
    return params.prevPageToken ? { actions: [], meta: {} }
      : { actions: Number(params.fromTimestamp) < from ? [action('boundary', from)] : [], meta: { prevPageToken: 'boundary-token' } };
  } });
  assert.equal(f.ranges[0][0].routeCount, 1);
  assert.equal(calls[0].fromTimestamp, String(from - 1));
  assert.equal(calls[1].timestamp, String(from + 86400));
});

test('a nonempty page with a missing continuation token cannot certify history', async () => {
  const f = fixture();
  await assert.rejects(refreshAffiliateRange({}, f.job, { ...f.options, fetchActions: async () => ({ actions: [action('one')], meta: {} }) }), /continuation token/);
  assert.equal(f.ranges.length, 0);
});

test('live-day pagination stays pinned to the captured source horizon across resumed pages', async () => {
  const f = fixture(); f.job.scan_watermark = from + 3600;
  const bounds = [];
  await refreshAffiliateRange({}, f.job, { ...f.options, fetchActions: async (params) => {
    bounds.push(Number(params.timestamp));
    return params.prevPageToken ? { actions: [], meta: {} }
      : { actions: [action('one')], meta: { prevPageToken: 'last' } };
  } });
  assert.deepEqual(bounds, [from + 3600, from + 3600]);
  assert.equal(f.ranges[0][0].completed_at, null);
});
