import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceFinancialDay, financialDetailDay, financialDaySnapshotComplete, readFinancialPoolWindow } from '../src/shared/financials-day-detail.js';
import { handleFinancials } from '../src/handlers/financials.js';

const now = Date.parse('2026-11-03T12:00:00Z');
const seconds = value => Date.parse(value) / 1000;

test('local day bounds use local midnight, including DST and fractional offsets', () => {
  for (const [day, zone, start, end] of [
    ['2026-10-29', 'America/New_York', '2026-10-29T04:00:00Z', '2026-10-30T04:00:00Z'],
    ['2026-03-08', 'America/New_York', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'],
    ['2026-11-01', 'America/New_York', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'],
    ['2026-09-06', 'America/Santiago', '2026-09-06T04:00:00Z', '2026-09-07T03:00:00Z'],
    ['2026-10-29', 'Asia/Kathmandu', '2026-10-28T18:15:00Z', '2026-10-29T18:15:00Z'],
    ['2026-10-29', 'Pacific/Kiritimati', '2026-10-28T10:00:00Z', '2026-10-29T10:00:00Z']
  ]) {
    const bounds = financialDetailDay(day, now, zone);
    assert.equal(bounds.from, seconds(start), `${day} ${zone} start`);
    assert.equal(bounds.to, seconds(end), `${day} ${zone} end`);
  }
});

test('a date already begun locally is valid even when the UTC calendar is still yesterday', () => {
  assert.equal(financialDetailDay('2026-10-30', Date.parse('2026-10-29T12:00:00Z'), 'Pacific/Kiritimati').from,
    seconds('2026-10-29T10:00:00Z'));
  assert.throws(() => financialDetailDay('2026-10-30', Date.parse('2026-10-29T09:00:00Z'), 'Pacific/Kiritimati'));
});

test('local pool totals reuse exact prefixes and sealed days without a provider request', async () => {
  const from = seconds('2026-10-29T04:00:00Z'), through = seconds('2026-10-30T04:00:00Z');
  const db = { query: async sql => ({ rows: sql.includes('pool_analysis_daily') ? [{
    asset: 'BTC.BTC', day: '2026-10-29', volume_rune_e8: '1000', volume_usd_e2: '2000',
    interval_start: '2026-10-29T00:00:00Z', interval_end: '2026-10-30T00:00:00Z',
    partial: false, completed_at: '2026-10-30T00:10:00Z', source: 'liquify-midgard-swaps'
  }] : [
    { asset: 'BTC.BTC', bucket_end: '2026-10-29T04:00:00Z', volume_rune_e8: '100', volume_usd_e2: '200' },
    { asset: 'BTC.BTC', bucket_end: '2026-10-30T04:00:00Z', volume_rune_e8: '300', volume_usd_e2: '600' }
  ] }) };
  const rows = await readFinancialPoolWindow(db, ['BTC.BTC'], { from, through });
  assert.deepEqual(rows, [{ asset: 'BTC.BTC', volumeRune: 0.000012, volumeUsd: 24 }]);
  const state = { day: '2026-10-29', timeZone: 'America/New_York', from, to: through, through,
    phase: 'pools', swaps: [], pools: ['BTC.BTC'], poolRows: [], pages: 0, unpriced: 0, pending: 0 };
  const result = await advanceFinancialDay(state.day, state, () => assert.fail('cached exact window needs no provider'), now,
    { timeZone: state.timeZone, readPools: (assets, window) => readFinancialPoolWindow(db, assets, window) });
  assert.equal(result.state.phase, 'done');
  assert.deepEqual(result.payload.pools, rows);
  const missing = { query: async sql => sql.includes('pool_analysis_daily') ? db.query(sql) : { rows: [] } };
  assert.deepEqual(await readFinancialPoolWindow(missing, ['BTC.BTC'], { from, through }), [], 'missing start cannot become yesterday’s full-day total');
});

test('local rankings exclude the previous evening and include the selected evening after UTC midnight', async () => {
  const day = '2026-10-29', from = seconds(`${day}T04:00:00Z`), to = from + 86400;
  const action = (id, at, value) => ({ type: 'swap', status: 'success', date: String(BigInt(at) * 1000000000n),
    in: [{ txID: id, coins: [{ asset: 'THOR.RUNE', amount: String(value * 1e8) }] }],
    out: [{ coins: [{ asset: 'BTC.BTC', amount: '100000000' }] }], pools: ['BTC.BTC'],
    metadata: { swap: { inPriceUSD: '10', liquidityFee: String(value * 1e8) } } });
  const routes = [];
  const getJson = async route => {
    routes.push(route);
    if (route === '/health') return { inSync: true, lastAggregated: { timestamp: to } };
    if (route.startsWith('/actions')) return { actions: [action('next-day', to, 100000),
      action('late-evening', to - 1, 20), action('midnight', from, 10), action('previous-evening', from - 1, 100000)] };
    const params = new URL(route, 'https://example.test').searchParams;
    assert.equal(Number(params.get('from')), from, 'pool data uses the same local-day start');
    assert.equal(params.get('interval'), '5min', 'a shifted 24-hour window must not request a UTC daily bucket');
    assert.equal(Number(params.get('count')), 288);
    return { intervals: Array.from({ length: 288 }, (_, index) => ({ startTime: String(from + index * 300),
      endTime: String(from + (index + 1) * 300), pools: [{ pool: 'BTC.BTC' }], totalVolumeUSD: '100', totalVolume: '200' })) };
  };
  let state = null, payload;
  for (let index = 0; index < 6 && !payload; index++) {
    ({ state, payload } = await advanceFinancialDay(day, state, getJson, now, { timeZone: 'America/New_York' }));
  }
  assert.ok(payload);
  assert.deepEqual(payload.swaps.map(row => row.txId), ['LATE-EVENING', 'MIDNIGHT']);
  assert.equal(payload.pools[0].volumeUsd, 288);
  assert.equal(payload.timeZone, 'America/New_York');
  assert.equal(financialDaySnapshotComplete(day, { ...payload, through: `${day}T23:59:59Z` }), false);
  assert.equal(financialDaySnapshotComplete(day, payload), true);
  assert.equal(routes.filter(route => route.startsWith('/actions')).length, 1);
});

test('day endpoint passes the validated timezone and rejects invalid zones before enqueueing', async () => {
  let received;
  const response = await handleFinancials({}, new URL('https://example.test/financials?day=2026-10-29&timeZone=America%2FNew_York'), {
    now: () => now, readDay: async (day, options) => { received = { day, timeZone: options?.timeZone }; return { day, loading: true }; }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received, { day: '2026-10-29', timeZone: 'America/New_York' });
  const invalid = await handleFinancials({}, new URL('https://example.test/financials?day=2026-10-29&timeZone=MadeUp%2FZone'), {
    now: () => now, readDay: () => assert.fail('invalid timezone must not enqueue')
  });
  assert.equal(invalid.status, 400);
});

test('numeric offset zones are rejected while IANA aliases share canonical calendar bounds', async () => {
  for (const timeZone of ['+04:00', '-0400', '+04']) {
    const response = await handleFinancials({}, new URL(`https://example.test/financials?day=2026-10-29&timeZone=${encodeURIComponent(timeZone)}`), {
      now: () => now, readDay: () => ({ loading: true })
    });
    assert.equal(response.status, 400, `${timeZone} must not reach PostgreSQL with opposite offset semantics`);
  }
  assert.deepEqual(financialDetailDay('2026-10-29', now, 'US/Eastern'),
    financialDetailDay('2026-10-29', now, 'America/New_York'));
  assert.deepEqual(financialDetailDay('2026-10-29', now, 'GMT'), financialDetailDay('2026-10-29', now, 'UTC'));
  assert.equal(financialDetailDay('2026-10-29', now, 'Etc/GMT+4').from, seconds('2026-10-29T04:00:00Z'));
});
