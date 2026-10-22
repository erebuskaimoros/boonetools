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

const cutoff = from + 12 * 3600;
const prefixRoute = `/history/swaps?interval=5min&from=${from}&count=144&pool=BTC.BTC`;
const prefix = { asset: 'BTC.BTC', bucket_end: new Date(cutoff * 1000),
  volume_rune_e8: '9007199254740993123456', volume_usd_e2: '987654321',
  observed_at: new Date((cutoff + 60) * 1000) };

test('exact intraday prefixes reuse the Pool Analysis ledger without losing integer precision', async () => {
  let reads = 0;
  const get = createFinancialDaySource({ client: { query: async (sql, args) => {
    reads++;
    assert.match(sql, /from pool_analysis_intraday_snapshots where asset = \$1 and bucket_end = \$2/);
    assert.match(sql, /volume_rune_e8::text/);
    assert.match(sql, /volume_usd_e2::text/);
    assert.match(sql, /observed_at/);
    assert.deepEqual(args, ['BTC.BTC', new Date(cutoff * 1000).toISOString()]);
    return { rows: [prefix] };
  } }, getJson: () => assert.fail('exact prefix must not spend an upstream request') });
  assert.deepEqual(await get(prefixRoute), { intervals: [{ startTime: String(from), endTime: String(cutoff),
    totalVolume: prefix.volume_rune_e8, totalVolumeUSD: prefix.volume_usd_e2 }] });
  assert.equal(reads, 1);
});

test('an observed zero-valued intraday prefix is a cache hit', async () => {
  const get = createFinancialDaySource({ client: { query: async () => ({ rows: [{ ...prefix,
    observed_at: prefix.bucket_end.toISOString(), volume_rune_e8: '0', volume_usd_e2: '0' }] }) },
  getJson: () => assert.fail('observed zero is not missing history') });
  assert.equal((await get(prefixRoute)).intervals[0].totalVolumeUSD, '0');
});

test('invalid intraday rows use the budgeted provider without substituting another horizon or pool', async () => {
  const candidates = [undefined, { ...prefix, asset: 'ETH.ETH' },
    { ...prefix, bucket_end: new Date((cutoff - 900) * 1000) },
    { ...prefix, bucket_end: new Date((cutoff + 900) * 1000) },
    { ...prefix, bucket_end: new Date((cutoff - 86400) * 1000) },
    { ...prefix, bucket_end: null }, { ...prefix, bucket_end: 'invalid' },
    { ...prefix, observed_at: null }, { ...prefix, observed_at: 'invalid' },
    { ...prefix, observed_at: new Date((cutoff - 1) * 1000) },
    { ...prefix, volume_rune_e8: '-1' }, { ...prefix, volume_rune_e8: 12 },
    { ...prefix, volume_usd_e2: null }, { ...prefix, volume_usd_e2: '1.5' },
    { ...prefix, volume_usd_e2: '1e5' }];
  for (const row of candidates) {
    let calls = 0;
    const get = createFinancialDaySource({ client: { query: async () => ({ rows: row ? [row] : [] }) },
      getJson: async value => { calls++; assert.equal(value, prefixRoute); return { upstream: true }; } });
    assert.deepEqual(await get(prefixRoute), { upstream: true });
    assert.equal(calls, 1);
  }
});

test('only an exact nonempty quarter-hour UTC-day prefix can use the intraday ledger', async () => {
  const values = [prefixRoute.replace('count=144', 'count=0'), prefixRoute.replace('count=144', 'count=-3'),
    prefixRoute.replace('count=144', 'count=145'), prefixRoute.replace('count=144', 'count=1.5'),
    prefixRoute.replace('count=144', 'count=1e2'), prefixRoute.replace('count=144', 'count=291'),
    prefixRoute.replace(String(from), String(from + 900)), prefixRoute.replace('from=', 'after='),
    prefixRoute.replace('&pool=BTC.BTC', ''), prefixRoute.replace('interval=5min', 'interval=hour'),
    `${prefixRoute}&to=${cutoff}`, `${prefixRoute}&type=swap`, `${prefixRoute}&pool=ETH.ETH`,
    `${prefixRoute}&pool=BTC.BTC`, `${prefixRoute}&count=144`, `${prefixRoute}&interval=5min`,
    `${prefixRoute}&from=${from}`];
  for (const value of values) {
    const get = createFinancialDaySource({ client: { query: () => assert.fail(`invalid prefix lookup: ${value}`) },
      getJson: async request => request });
    assert.equal(await get(value), value);
  }
});

test('next-midnight zero snapshots never stand in for the preceding completed day', async () => {
  const nextMidnight = { ...prefix, bucket_end: new Date((from + 86400) * 1000),
    volume_rune_e8: '0', volume_usd_e2: '0', observed_at: new Date((from + 86400) * 1000) };
  const fullDayRoute = prefixRoute.replace('count=144', 'count=288');
  const get = createFinancialDaySource({ client: { query: async () => assert.fail('a midnight prefix belongs to the new day') },
    getJson: async request => ({ upstream: request }) });
  assert.deepEqual(await get(fullDayRoute), { upstream: fullDayRoute });
  const daily = createFinancialDaySource({ client: { query: async sql => {
    assert.match(sql, /from pool_analysis_daily /);
    return { rows: [nextMidnight] };
  } }, getJson: async request => ({ upstream: request }) });
  assert.deepEqual(await daily(route), { upstream: route });
});

test('duplicate request parameters or multiple cache rows are never silently ignored', async () => {
  for (const suffix of ['&pool=ETH.ETH', '&interval=day', '&from=0', '&count=1']) {
    const get = createFinancialDaySource({ client: { query: () => assert.fail('duplicate parameters must bypass the cache') },
      getJson: async request => request });
    assert.equal(await get(route + suffix), route + suffix);
  }
  for (const [request, row] of [[route, cached], [prefixRoute, prefix]]) {
    const get = createFinancialDaySource({ client: { query: async () => ({ rows: [row, row] }) },
      getJson: async () => ({ upstream: true }) });
    assert.deepEqual(await get(request), { upstream: true });
  }
});

test('intraday cache database failure fails closed instead of triggering provider traffic', async () => {
  const get = createFinancialDaySource({ client: { query: async () => { throw new Error('database unavailable'); } },
    getJson: () => assert.fail('cache outage must not amplify upstream traffic') });
  await assert.rejects(get(prefixRoute), /database unavailable/);
});
