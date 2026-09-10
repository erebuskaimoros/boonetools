import test from 'node:test';
import assert from 'node:assert/strict';
import { BinaryWriter } from 'cosmjs-types/binary.js';
import {
  appendFinancialsLivePoint, buildFinancialsPoints, buildLiveFinancialsPoint, dailyBondingApr, daySeconds, financialsWindow,
  FINANCIALS_START_DAY, summarizeFinancials
} from '../../shared/financials/model.js';
import { decodeActiveBond, fetchFinancialBondDay, fetchFinancialHistory, fetchFinancialLiveTotals, findFinancialClosingBlock } from '../src/shared/financials-history.js';
import { createFinancialsService } from '../src/shared/financials-service.js';

const DAY = 86400;
const from = daySeconds('2026-08-01');
const interval = (index, fields = {}) => ({ startTime: String(from + index * DAY), endTime: String(from + (index + 1) * DAY), ...fields });
function nodeResponse(nodes) {
  const response = BinaryWriter.create();
  for (const node of nodes) {
    const writer = BinaryWriter.create();
    writer.uint32(18).string(node.status || 'Active');
    if (node.bond != null) writer.uint32(74).string(node.bond);
    writer.uint32(56).int64(BigInt(node.since || 1));
    // An unneeded field must not disrupt decoding the stable bond fields.
    writer.uint32(34).string('test-validator-key');
    response.uint32(10).bytes(writer.finish());
  }
  return Buffer.from(response.finish()).toString('base64');
}

test('Financials defaults to exactly 30 completed UTC days and all-time begins at mainnet', () => {
  const window = financialsWindow(undefined, Date.parse('2026-09-10T05:00:00Z'));
  assert.equal(window.from, daySeconds('2026-08-11'));
  assert.equal(window.to, daySeconds('2026-09-10'));
  assert.equal((window.to - window.from) / DAY, 30);
  assert.equal(financialsWindow('all').from, daySeconds(FINANCIALS_START_DAY));
  assert.throws(() => financialsWindow('5000d'), /Unknown/);
  assert.throws(() => daySeconds('2026-02-30'), /Invalid/);
});

test('Protocol volume uses Midgard cents and income includes emissions at the matching daily price', () => {
  const points = buildFinancialsPoints({
    from, to: from + DAY * 2,
    swaps: [interval(1, { totalVolumeUSD: '50000', totalVolume: '90000000000' }), interval(0, { totalVolumeUSD: '123456', totalVolume: '100000000000' })],
    earnings: [interval(0, { earnings: '3000000000', liquidityFees: '2000000000', blockRewards: '1000000000', bondingEarnings: '1000000000', runePriceUSD: '2' }), interval(1, { earnings: '3000000000', runePriceUSD: '4' })],
    bonds: { '2026-08-01': { activeBondE8: '100000000000', height: 100, timestamp: from + DAY - 2 } }
  });
  assert.equal(points[0].volumeUsd, 1234.56);
  assert.equal(points[0].volumeRune, 1000);
  assert.equal(points[0].incomeRune, 30);
  assert.equal(points[0].incomeUsd, 60);
  assert.equal(points[1].incomeUsd, 120);
  assert.equal(points[0].bondingApr, 365);
  assert.equal(points[1].bondingApr, null);
});

test('Unavailable days and prices remain gaps while observed zero earnings produce zero APR', () => {
  const points = buildFinancialsPoints({ from, to: from + DAY * 3,
    swaps: [interval(0, { totalVolumeUSD: '0', totalVolume: '0' })],
    earnings: [interval(0, { earnings: '0', bondingEarnings: '0', runePriceUSD: '2' }), interval(2, { earnings: '100000000', runePriceUSD: 'NaN' })],
    bonds: { '2026-08-01': { activeBondE8: '100000000' } }
  });
  assert.equal(points[0].volumeUsd, 0);
  assert.equal(points[0].incomeUsd, 0);
  assert.equal(points[0].bondingApr, 0);
  assert.equal(points[1].incomeRune, null);
  assert.equal(points[1].volumeUsd, null);
  assert.equal(points[2].incomeRune, 1);
  assert.equal(points[2].incomeUsd, null);
  assert.equal(dailyBondingApr('1', '0'), null);
  assert.equal(dailyBondingApr(null, '100'), null);
});

test('Summary averages use only observed days and never turn a missing period into a zero total', () => {
  const points = [{ volumeUsd: 100, incomeUsd: 20, bondingApr: 10, day: '2026-08-01' },
    { volumeUsd: null, incomeUsd: null, bondingApr: null, day: '2026-08-02' },
    { volumeUsd: 0, incomeUsd: 0, bondingApr: 0, day: '2026-08-03' }];
  const summary = summarizeFinancials(points);
  assert.deepEqual(summary.income, { value: 20, days: 2 });
  assert.equal(summary.averageDailyIncome, 10);
  assert.equal(summary.averageApr, 5);
  assert.equal(summary.latestApr, 0);
  assert.equal(summarizeFinancials([]).volume.value, null);
});

test('Unbonding reduces the next daily denominator without being treated as negative earnings', () => {
  const points = buildFinancialsPoints({ from, to: from + 2 * DAY,
    earnings: [0, 1].map((day) => interval(day, { earnings: '20000000000', bondingEarnings: '10000000000', runePriceUSD: '1' })),
    bonds: {
      '2026-08-01': { activeBondE8: '100000000000000' },
      '2026-08-02': { activeBondE8: '80000000000000' }
    }
  });
  assert.equal(points[0].activeBondRune, 1000000);
  assert.equal(points[1].activeBondRune, 800000);
  assert.equal(points[0].incomeRune, 200);
  assert.equal(points[1].incomeRune, 200);
  assert.ok(Math.abs(points[0].bondingApr - 3.65) < 1e-12);
  assert.equal(points[1].bondingApr, 4.5625);
});

test('Short or misaligned intervals cannot masquerade as completed UTC days', () => {
  const points = buildFinancialsPoints({ from, to: from + DAY, earnings: [
    { startTime: from, endTime: from + DAY - 100, earnings: '100000000', runePriceUSD: '2' }
  ] });
  assert.equal(points[0].incomeUsd, null);
});

test('Live APR annualizes only elapsed covered time and partial days do not dilute daily averages', () => {
  const point = buildLiveFinancialsPoint({ from, through: from + DAY / 4,
    swaps: { totalVolume: '100000000000', totalVolumeUSD: '50000' },
    earnings: { earnings: '3000000000', bondingEarnings: '1000000000', runePriceUSD: '2' },
    bond: { activeBondE8: '100000000000' }
  });
  assert.equal(point.partial, true);
  assert.equal(point.incomeUsd, 60);
  assert.equal(point.bondingApr, 1460);
  assert.equal(point.elapsedSeconds, DAY / 4);
  const summary = summarizeFinancials([
    { day: '2026-07-31', volumeUsd: 100, incomeUsd: 20, bondingApr: 10 }, point
  ]);
  assert.equal(summary.income.value, 80);
  assert.equal(summary.averageDailyIncome, 20);
  assert.equal(summary.averageApr, 10);
  assert.equal(summary.aprDays, 2);
  assert.equal(summary.averageAprDays, 1);
  assert.equal(buildLiveFinancialsPoint({ from }).incomeRune, null);
  assert.equal(dailyBondingApr('1', '100', 0), null);
});

test('Live day replaces any duplicate and keeps rolling ranges at 30 calendar days across midnight', () => {
  const rows = Array.from({ length: 31 }, (_, index) => ({ day: new Date((from + index * DAY) * 1000).toISOString().slice(0, 10) }));
  const today = { ...rows.at(-1), partial: true, volumeUsd: 10 };
  const points = appendFinancialsLivePoint(rows, today, '30d');
  assert.equal(points.length, 30);
  assert.equal(points[0].day, '2026-08-02');
  assert.equal(points.at(-1).volumeUsd, 10);
  assert.equal(appendFinancialsLivePoint(rows, today, 'all').length, 31);
});

test('Live totals sum completed five-minute buckets exactly and ignore future zero placeholders', async () => {
  const calls = [];
  const getJson = async (url) => {
    calls.push(new URL(url));
    return { intervals: Array.from({ length: 3 }, (_, i) => ({
      startTime: from + i * 300, endTime: from + (i + 1) * 300,
      totalVolume: '9007199254740993', totalVolumeUSD: '150',
      earnings: '30', liquidityFees: '20', blockRewards: '10', bondingEarnings: '15', runePriceUSD: String(i + 1)
    })) };
  };
  const result = await fetchFinancialLiveTotals(from, from + 600, { getJson });
  assert.equal(result.swaps.totalVolume, '18014398509481986');
  assert.equal(result.swaps.totalVolumeUSD, '300');
  assert.equal(result.earnings.earnings, '60');
  assert.equal(result.earnings.runePriceUSD, '2');
  assert.equal(calls[0].searchParams.get('interval'), '5min');
  assert.equal(calls[0].searchParams.get('count'), '2');
  assert.equal(calls[0].searchParams.has('to'), false);
  await assert.rejects(fetchFinancialLiveTotals(from, from + 600, { getJson: async (url) => {
    const result = await getJson(url); result.intervals.splice(1, 1); return result;
  } }), /Incomplete live/);
});

test('Long history paginates beyond the 400-day cap without count/from/to overconstraint', async () => {
  const calls = [];
  const rows = await fetchFinancialHistory('earnings', { from, to: from + 401 * DAY,
    getJson: async (url) => {
      const u = new URL(url); calls.push(u);
      const start = Number(u.searchParams.get('from'));
      assert.equal(u.searchParams.has('to'), false);
      const count = Number(u.searchParams.get('count'));
      return { intervals: Array.from({ length: count }, (_, i) => ({ startTime: String(start + i * DAY), endTime: String(start + (i + 1) * DAY), pools: [1, 2], earnings: '1' })) };
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.get('count'), '400');
  assert.equal(calls[1].searchParams.get('count'), '1');
  assert.equal(rows.length, 401);
  assert.equal(rows[400].startTime, String(from + DAY * 400));
  assert.equal('pools' in rows[0], false);
});

test('Ignored history pagination is rejected and empty source days stay absent', async () => {
  await assert.rejects(fetchFinancialHistory('swaps', { from, to: from + DAY, getJson: async () => ({ intervals: [interval(20)] }) }), /wrong date range/);
  assert.deepEqual(await fetchFinancialHistory('swaps', { from, to: from + DAY, getJson: async () => ({ intervals: [] }) }), []);
});

test('Historical bond decoder sums only active nodes and keeps base-unit precision', () => {
  assert.deepEqual(decodeActiveBond(nodeResponse([
    { bond: '9007199254740993' }, { bond: '7' }, { status: 'Standby', bond: '50000000000000000' }
  ]), 100), { activeBondE8: '9007199254741000', activeNodes: 2 });
  assert.throws(() => decodeActiveBond(nodeResponse([{ bond: '10', since: 101 }]), 100), /newer/);
  assert.throws(() => decodeActiveBond(nodeResponse([{ bond: null }]), 100), /missing/);
  assert.throws(() => decodeActiveBond(nodeResponse([{ status: 'Standby', bond: '10' }]), 100), /unavailable/);
});

test('Bond snapshot resolves a same-day block and validates RPC height before using its bond', async () => {
  const calls = [];
  const getJson = async (url) => {
    calls.push(new URL(url));
    if (url.includes('/actions?')) return { actions: [{ height: '100', date: String(BigInt(from + DAY - 2) * 1_000_000_000n) }] };
    return { result: { response: { code: 0, height: '100', value: nodeResponse([{ bond: '500000000' }]) } } };
  };
  const bond = await fetchFinancialBondDay(from, { getJson });
  assert.equal(bond.activeBondE8, '500000000');
  assert.equal(bond.timestamp, from + DAY - 2);
  assert.equal(calls[0].searchParams.get('timestamp'), String(from + DAY));
  assert.equal(calls[1].searchParams.get('height'), '100');
  assert.equal(calls[1].searchParams.get('path'), '"/types.Query/Nodes"');
  await assert.rejects(fetchFinancialBondDay(from, { getJson: async (url) => {
    const data = await getJson(url);
    if (data.result) data.result.response.height = '101';
    return data;
  } }), /requested historical block/);
});

test('A stale action block from a different day cannot populate a daily APR', async () => {
  await assert.rejects(fetchFinancialBondDay(from, { getJson: async () => ({ actions: [{ height: '100', date: String(BigInt(from - 2) * 1_000_000_000n) }] }) }), /closing-day block/);
});

test('Live bond queries stop at the matching intraday cutoff rather than the end of today', async () => {
  const cutoff = from + 6 * 3600;
  const bond = await fetchFinancialBondDay(from, { to: cutoff, getJson: async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/actions')) {
      assert.equal(u.searchParams.get('timestamp'), String(cutoff));
      return { actions: [{ height: '100', date: String(BigInt(cutoff - 2) * 1_000_000_000n) }] };
    }
    assert.equal(u.searchParams.get('height'), '100');
    return { result: { response: { code: 0, height: '100', value: nodeResponse([{ bond: '500000000' }]) } } };
  } });
  assert.equal(bond.timestamp, cutoff - 2);
});

test('A no-action day gets a closing balance only after adjacent block times prove the boundary', async () => {
  const to = from + DAY;
  const getJson = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/actions')) return { actions: [{ height: '1', date: String(BigInt(from - DAY) * 1_000_000_000n) }] };
    if (u.pathname.endsWith('/blockchain')) {
      const first = Number(u.searchParams.get('minHeight'));
      return { result: { block_metas: [first + 1, first].map((height) => ({ header: {
        height: String(height), time: new Date((from - DAY + (height - 1) * 6) * 1000).toISOString()
      } })) } };
    }
    return { result: { response: { code: 0, height: u.searchParams.get('height'), value: nodeResponse([{ bond: '10000000000' }]) } } };
  };
  const head = { height: 40001, timestamp: from - DAY + 40000 * 6 };
  const boundary = await findFinancialClosingBlock(to, { height: 1, timestamp: from - DAY }, { getJson, head });
  assert.equal(boundary.height, 28800);
  assert.equal(boundary.timestamp, to - 6);
  const bond = await fetchFinancialBondDay(from, { getJson, head });
  assert.equal(bond.height, boundary.height);
  assert.equal(bond.blockTimeVerified, true);
  assert.equal(dailyBondingApr('0', bond.activeBondE8), 0);
});

test('Block-time lookup rejects an archive returning the wrong block heights', async () => {
  await assert.rejects(findFinancialClosingBlock(from + DAY,
    { height: 1, timestamp: from - DAY }, {
      head: { height: 100000, timestamp: from + 2 * DAY },
      getJson: async () => ({ result: { block_metas: [{ header: { height: '2', time: '2026-08-01T00:00:00Z' } }] } })
    }), /Invalid historical block-time response/);
});

test('Dev data cache reuses history, excludes unindexed buckets, and serves stale data after failure', async () => {
  let clock = Date.parse('2026-09-10T06:00:00Z');
  const initial = clock;
  let fail = false;
  let calls = 0;
  const service = createFinancialsService({ now: () => clock, requestSpacingMs: 0,
    fetchImpl: async (url) => {
      calls++;
      if (fail) return new Response('{}', { status: 503 });
      if (url.endsWith('/health')) return Response.json({ inSync: true, lastAggregated: { timestamp: initial / 1000, height: 100 } });
      if (url.includes('/actions?')) return Response.json({ actions: [] });
      const params = new URL(url).searchParams;
      const start = Number(params.get('from'));
      return Response.json({ intervals: Array.from({ length: Number(params.get('count')) }, (_, i) => ({
        startTime: String(start + i * DAY), endTime: String(start + (i + 1) * DAY),
        totalVolume: '100000000', totalVolumeUSD: '200', earnings: '100000000', runePriceUSD: '2'
      })) });
    }
  });
  try {
    const data = await service.getHistory();
    assert.equal(data.points.length, 30);
    assert.equal(data.points[0].incomeUsd, 2);
    const second = await service.getHistory();
    assert.equal(second.points[0].volumeUsd, 2);
    assert.ok(calls < 15, 'concurrent read must not repeat provider history calls');
    clock += 6 * 60_000; fail = true;
    const stale = await service.getHistory();
    assert.equal(stale.stale, true);
    assert.equal(stale.points[0].volumeUsd, 2);
    assert.match(stale.error, /503/);
  } finally { await service.stop(); }
});

test('Live service refreshes at bucket boundaries, coalesces tabs, survives outages, and drops yesterday partials', async () => {
  let clock = Date.parse('2026-09-10T00:10:20Z');
  let fail = false;
  let liveCalls = 0;
  let indexLag = 0;
  const service = createFinancialsService({ now: () => clock, requestSpacingMs: 0,
    fetchImpl: async (url) => {
      if (fail) return new Response('{}', { status: 503 });
      if (url.endsWith('/health')) return Response.json({ inSync: true, lastAggregated: { timestamp: clock / 1000 - indexLag, height: 100000 } });
      if (url.includes('/actions?')) return Response.json({ actions: [] });
      const params = new URL(url).searchParams;
      const step = params.get('interval') === '5min' ? 300 : DAY;
      if (step === 300) liveCalls++;
      const start = Number(params.get('from'));
      return Response.json({ intervals: Array.from({ length: Number(params.get('count')) }, (_, i) => ({
        startTime: String(start + i * step), endTime: String(start + (i + 1) * step),
        totalVolume: '100000000', totalVolumeUSD: '200', earnings: '100000000',
        liquidityFees: '60000000', blockRewards: '40000000', bondingEarnings: '50000000', runePriceUSD: '2'
      })) });
    }
  });
  try {
    const [first, concurrent] = await Promise.all([service.getHistory(), service.getHistory()]);
    assert.equal(first.points.length, 30);
    assert.equal(first.points.at(-1).incomeUsd, 4);
    assert.equal(concurrent.points.at(-1).incomeUsd, 4);
    assert.equal(first.live.through, '2026-09-10T00:10:00.000Z');
    assert.equal(liveCalls, 2);
    clock += 35_000;
    await service.getHistory();
    assert.equal(liveCalls, 2, 'same five-minute cutoff should reuse totals');
    clock = Date.parse('2026-09-10T00:15:20Z');
    indexLag = 3 * 60;
    const delayedIndex = await service.getHistory();
    assert.equal(delayedIndex.live.through, '2026-09-10T00:10:00.000Z');
    assert.equal(liveCalls, 2, 'unindexed five-minute bucket must not be included');
    indexLag = 0; clock += 35_000;
    const next = await service.getHistory();
    assert.equal(next.points.at(-1).incomeUsd, 6);
    assert.equal(liveCalls, 4);
    fail = true; clock += 35_000;
    const stale = await service.getHistory();
    assert.equal(stale.points.at(-1).incomeUsd, 6);
    assert.equal(stale.live.stale, true);
    assert.match(stale.live.error, /503/);
    clock = Date.parse('2026-09-11T00:01:00Z');
    const rollover = await service.getHistory();
    assert.equal(rollover.points.at(-1).day, '2026-09-11');
    assert.equal(rollover.points.at(-1).incomeUsd, null);
    assert.equal(rollover.points.find((point) => point.day === '2026-09-10').incomeUsd, null);
    fail = false; clock += 35_000;
    const recovered = await service.getHistory();
    assert.equal(recovered.live.stale, false);
    assert.equal(recovered.points.at(-1).incomeUsd, null, 'first five-minute bucket has not completed');
    assert.equal(recovered.points.find((point) => point.day === '2026-09-10').incomeUsd, 2, 'yesterday is replaced with completed daily history');
  } finally { await service.stop(); }
});
