import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinancialDaySource } from '../src/shared/financials-day-source.js';

const from = Date.parse('2026-10-16T00:00:00Z') / 1000;
const route = `/history/swaps?interval=day&from=${from}&count=1&pool=BTC.BTC`;
const cached = {
  asset: 'BTC.BTC', day: '2026-10-16', volume_rune_e8: '1155216533503692', volume_usd_e2: '750427636',
  interval_start: new Date(from * 1000), interval_end: new Date((from + 86400) * 1000),
  completed_at: new Date('2026-10-18T00:00:00Z'), partial: false, source: 'liquify-midgard-swaps'
};

test('exact completed per-pool history is reused without a Midgard request', async () => {
  let reads = 0;
  const get = createFinancialDaySource({ client: { query: async (_sql, args) => {
    reads++; assert.deepEqual(args, ['BTC.BTC', '2026-10-16']); return { rows: [cached] };
  } }, getJson: () => assert.fail('cached pool must not spend an upstream request') });
  const result = await get(route);
  assert.deepEqual(result, { intervals: [{ startTime: String(from), endTime: String(from + 86400),
    totalVolume: cached.volume_rune_e8, totalVolumeUSD: cached.volume_usd_e2 }] });
  assert.equal(reads, 1);
});

test('zero volume is an observed value, not a cache miss', async () => {
  const get = createFinancialDaySource({ client: { query: async () => ({ rows: [{ ...cached, volume_rune_e8: '0', volume_usd_e2: '0' }] }) },
    getJson: () => assert.fail('observed zero must not refetch') });
  assert.equal((await get(route)).intervals[0].totalVolumeUSD, '0');
});

test('missing, partial, unverified, mismatched and malformed pool rows use the budgeted source', async () => {
  for (const row of [undefined, { ...cached, partial: true }, { ...cached, completed_at: null },
    { ...cached, interval_end: new Date((from + 86399) * 1000) }, { ...cached, interval_start: new Date((from + 1) * 1000) },
    { ...cached, asset: 'ETH.ETH' }, { ...cached, day: '2026-10-15' }, { ...cached, source: 'unknown' },
    { ...cached, volume_usd_e2: null }, { ...cached, volume_rune_e8: '-1' }, { ...cached, volume_usd_e2: '1.5' }]) {
    let calls = 0;
    const get = createFinancialDaySource({ client: { query: async () => ({ rows: row ? [row] : [] }) },
      getJson: async value => { calls++; assert.equal(value, route); return { upstream: true }; } });
    assert.deepEqual(await get(route), { upstream: true }); assert.equal(calls, 1);
  }
});

test('live, non-pool, multi-day and differently filtered requests cannot borrow a full-day cache row', async () => {
  for (const value of ['/health', '/actions?limit=50', `/history/earnings?interval=day&from=${from}&count=1`,
    route.replace('interval=day', 'interval=5min'), route.replace('count=1', 'count=2'),
    route.replace(String(from), String(from + 1)), `${route}&to=${from + 3600}`]) {
    const get = createFinancialDaySource({ client: { query: () => assert.fail('wrong cache window') }, getJson: async request => request });
    assert.equal(await get(value), value);
  }
});

test('cache database failure fails closed rather than causing an unbudgeted fallback storm', async () => {
  const get = createFinancialDaySource({ client: { query: async () => { throw new Error('database unavailable'); } },
    getJson: () => assert.fail('cache outage must not amplify upstream traffic') });
  await assert.rejects(get(route), /database unavailable/);
});
