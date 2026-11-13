import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_STABLE_SWAP_RANGE,
  STABLE_SWAP_RANGES,
  normalizeStableSwapsPayload,
  selectStableSwapRange,
  stableSwapBackfillNote,
  stableSwapFeeBps,
  weightedStableSwapFeeBps
} from '../src/lib/dynamic-fees/stable-swaps.js';
import {
  STABLE_SWAP_DEFAULT_HIDDEN,
  buildStableSwapsOption,
  stableSwapObservedFeesReducer,
  stableSwapsTooltip
} from '../src/lib/dynamic-fees/stable-swaps-chart.js';

const day = (offset) => new Date(Date.UTC(2026, 10, 2 + offset)).toISOString().slice(0, 10);

// 2026-11-02 is a Monday, so the first seven rows form one complete UTC week.
const payload = {
  as_of: '2026-11-15T12:00:00Z',
  coverage_start: '2026-11-02',
  stable_symbols: ['USDC', 'USDT', '', 7],
  source: 'finalized-block swap ledger',
  days: Array.from({ length: 14 }, (_, index) => ({
    day: day(index),
    swaps: index + 1,
    volume_usd: index === 0 ? 1_000_000 : index === 3 ? 0 : 1_000,
    fees_rune: index,
    fees_usd: index === 0 ? 100 : index === 3 ? 0 : index === 5 ? null : 10,
    partial: index === 13
  }))
};

test('normalization parses numbers defensively and derives the effective fee rate', () => {
  const result = normalizeStableSwapsPayload({
    as_of: 42,
    coverage_start: 'not-a-day',
    stable_symbols: 'USDC',
    days: [
      { day: '2026-11-03', swaps: '4', volume_usd: '2000', fees_rune: '1.5', fees_usd: '3', partial: 'true' },
      { day: '2026-11-02T00:00:00Z', swaps: null, volume_usd: 'NaN', fees_usd: null, fees_rune: true },
      { day: '2026-11-04', swaps: -1, volume_usd: 0, fees_usd: 0, partial: true },
      { day: 'bad', volume_usd: 1 },
      null,
      { day: '2026-13-40', volume_usd: 1 }
    ]
  });
  assert.equal(result.asOf, null);
  assert.equal(result.coverageStart, null);
  assert.deepEqual(result.stableSymbols, []);
  assert.equal(result.source, 'finalized-block swap ledger');
  assert.deepEqual(result.days.map((row) => row.day), ['2026-11-02', '2026-11-03', '2026-11-04']);
  assert.deepEqual(result.days[0], {
    day: '2026-11-02', swaps: null, volumeUsd: null, feesUsd: null, feesRune: null, feeBps: null, partial: false
  });
  assert.deepEqual(result.days[1], {
    day: '2026-11-03', swaps: 4, volumeUsd: 2000, feesUsd: 3, feesRune: 1.5, feeBps: 15, partial: false
  });
  // Zero volume has no defined rate; only a literal true marks the live day.
  assert.equal(result.days[2].feeBps, null);
  assert.equal(result.days[2].swaps, null);
  assert.equal(result.days[2].partial, true);

  for (const empty of [null, undefined, 'x', [], { days: 'nope' }]) {
    const normalized = normalizeStableSwapsPayload(empty);
    assert.deepEqual(normalized.days, []);
    assert.equal(normalized.coverageStart, null);
  }

  const full = normalizeStableSwapsPayload(payload);
  assert.equal(full.coverageStart, '2026-11-02');
  assert.deepEqual(full.stableSymbols, ['USDC', 'USDT']);
  assert.equal(full.days.length, 14);
  assert.equal(full.days[5].feesUsd, null);
  assert.equal(full.days[5].feeBps, null);
  assert.equal(full.days[13].partial, true);
  assert.equal(full.days.filter((row) => row.partial).length, 1);
});

test('normalization reads ledger start and backfill progress defensively', () => {
  // Older backends omit both fields.
  const absent = normalizeStableSwapsPayload(payload);
  assert.equal(absent.ledgerStart, null);
  assert.equal(absent.backfill, null);

  for (const backfill of [null, 'running', 7, [], true]) {
    assert.equal(normalizeStableSwapsPayload({ ...payload, backfill }).backfill, null);
  }
  const malformed = normalizeStableSwapsPayload({
    ...payload, ledger_start: '2026-02-30x',
    backfill: { target_start: 'soon', complete_from: 20261101, complete: 'true', floor_reason: '  ' }
  });
  assert.equal(malformed.ledgerStart, null);
  assert.deepEqual(malformed.backfill, { targetStart: null, completeFrom: null, complete: false, floorReason: null });

  const valid = normalizeStableSwapsPayload({
    ...payload, ledger_start: '2026-10-29',
    backfill: { target_start: '2026-08-15', complete_from: '2026-09-20', complete: true, floor_reason: ' archive pruned ' }
  });
  assert.equal(valid.ledgerStart, '2026-10-29');
  assert.deepEqual(valid.backfill, {
    targetStart: '2026-08-15', completeFrom: '2026-09-20', complete: true, floorReason: 'archive pruned'
  });
});

test('backfill note discloses progress, an archive floor, or nothing', () => {
  const note = (coverageStart, backfill) => stableSwapBackfillNote({ coverageStart, backfill });
  assert.equal(stableSwapBackfillNote(null), '');
  assert.equal(note('2026-10-29', null), '');
  assert.equal(note('2026-09-20', { targetStart: '2026-08-15', completeFrom: '2026-09-20', complete: false, floorReason: null }),
    'BACKFILL TO 2026-08-15 UTC IN PROGRESS');
  assert.equal(note('2026-10-29', { targetStart: null, completeFrom: null, complete: false, floorReason: null }),
    'BACKFILL IN PROGRESS');
  assert.equal(note('2026-09-20', { targetStart: '2026-08-15', completeFrom: '2026-09-20', complete: true, floorReason: 'archive pruned' }),
    'HISTORY LIMITED BY ARCHIVE AVAILABILITY');
  // A floor reason without a later coverage start is not a limitation.
  assert.equal(note('2026-08-15', { targetStart: '2026-08-15', completeFrom: '2026-08-15', complete: true, floorReason: 'archive pruned' }), '');
  assert.equal(note('2026-08-15', { targetStart: '2026-08-15', completeFrom: '2026-08-15', complete: true, floorReason: null }), '');
  assert.equal(note('2026-09-20', { targetStart: '2026-08-15', completeFrom: '2026-09-20', complete: true, floorReason: null }), '');
});

test('fee rate helpers weight by volume and ignore days without USD fees', () => {
  assert.equal(stableSwapFeeBps(1, 1000), 10);
  assert.equal(stableSwapFeeBps(1, 0), null);
  assert.equal(stableSwapFeeBps(null, 1000), null);
  const rows = [
    { volumeUsd: 1_000_000, feesUsd: 100 },
    { volumeUsd: 1_000, feesUsd: 10 },
    { volumeUsd: 5_000, feesUsd: null }
  ];
  assert.equal(weightedStableSwapFeeBps(rows), 110 / 1_001_000 * 10_000);
  assert.equal(weightedStableSwapFeeBps([]), null);
  assert.equal(weightedStableSwapFeeBps([{ volumeUsd: 0, feesUsd: 0 }]), null);
});

test('range selection keeps the trailing UTC days and defaults to all history', () => {
  assert.deepEqual(STABLE_SWAP_RANGES.map((range) => range.label), ['1W', '1M', '3M', '6M', '1Y', 'ALL']);
  assert.equal(DEFAULT_STABLE_SWAP_RANGE, 'all');
  const rows = Array.from({ length: 400 }, (_, index) => ({ day: String(index) }));
  assert.equal(selectStableSwapRange(rows).length, 400);
  assert.deepEqual(selectStableSwapRange(rows, '7d').map((row) => row.day), rows.slice(-7).map((row) => row.day));
  assert.equal(selectStableSwapRange(rows, '30d').length, 30);
  assert.equal(selectStableSwapRange(rows, '365d').length, 365);
  assert.equal(selectStableSwapRange(rows, 'unknown').length, 400);
  assert.equal(selectStableSwapRange(rows.slice(0, 5), '30d').length, 5);
  assert.deepEqual(selectStableSwapRange(null, '7d'), []);
});

test('chart builder declares volume/fees flows and a hidden, volume-weighted fee rate', () => {
  const rows = normalizeStableSwapsPayload(payload).days;
  const option = buildStableSwapsOption(rows);
  assert.deepEqual(STABLE_SWAP_DEFAULT_HIDDEN, ['feeBps']);
  const spec = option._spec;
  assert.deepEqual(spec.series.map((item) => [item.id, item.mark, item.axis]),
    [['volume', 'bar', 'volume'], ['fees', 'line', 'fees'], ['feeBps', 'line', 'feeBps']]);
  assert.equal(spec.series[0].aggregate, 'sum');
  assert.equal(spec.series[1].aggregate, stableSwapObservedFeesReducer);
  // Fees average as a daily mean in the rolling menu; no custom rolling reducer.
  assert.equal(spec.series[1].rollingReduce, undefined);
  assert.equal(typeof spec.series[2].aggregate, 'function');
  assert.equal(spec.series[2].dashed, true);
  assert.deepEqual(spec.axes.map((axis) => [axis.id, axis.position]),
    [['volume', 'left'], ['fees', 'right'], ['feeBps', 'right']]);

  // Default: the rate series and its axis are hidden; volume/fees are plotted.
  assert.deepEqual(option.series.find((item) => item.id === 'feeBps').data, []);
  assert.equal(option.yAxis.find((axis) => axis.id === 'feeBps').show, false);
  assert.equal(option.series.find((item) => item.id === 'volume').data.length, 14);

  // The live partial day is drawn with a lighter bar fill.
  const fill = option.series.find((item) => item.id === 'volume').itemStyle.color;
  assert.notEqual(fill({ dataIndex: 13 }), fill({ dataIndex: 12 }));

  const daily = option.tooltip.formatter([{ dataIndex: 13, axisValue: rows[13].day }]);
  assert.match(daily, /SWAPS: 14/);
  assert.match(daily, /LIVE PARTIAL UTC DAY/);
  assert.doesNotMatch(daily, /EFFECTIVE FEE/);
  assert.doesNotMatch(stableSwapsTooltip(rows[12]), /LIVE PARTIAL/);
});

test('weekly buckets sum flows and weight the fee rate by volume, not by day', () => {
  const rows = normalizeStableSwapsPayload(payload).days;
  const weekly = buildStableSwapsOption(rows, { analysis: { grain: 'week', hidden: [] } });
  assert.deepEqual(weekly.xAxis.data, ['2026-11-02', '2026-11-09']);
  const data = (id) => weekly.series.find((item) => item.id === id).data;
  const firstWeek = rows.slice(0, 7);
  assert.equal(data('volume')[0], 1_000_000 + 5 * 1_000);
  // One unpriced day leaves the observed sum of the priced days, not a gap.
  assert.equal(data('fees')[0], 140);
  assert.equal(data('fees')[1], 70);
  const weighted = (100 + 4 * 10) / (1_000_000 + 4 * 1_000) * 10_000;
  assert.ok(Math.abs(data('feeBps')[0] - weighted) < 1e-9);
  const dailyRates = firstWeek.map((row) => row.feeBps).filter(Number.isFinite);
  const unweightedMean = dailyRates.reduce((sum, value) => sum + value, 0) / dailyRates.length;
  assert.ok(Math.abs(data('feeBps')[0] - unweightedMean) > 1);
  assert.equal(data('feeBps')[1], 100);

  const tooltip = weekly.tooltip.formatter([{ dataIndex: 1, axisValue: '2026-11-09' }]);
  assert.match(tooltip, /2026-11-09 → 2026-11-15 · UTC WEEK · PARTIAL BUCKET/);
  assert.match(tooltip, /SWAPS: 77/);
  assert.match(tooltip, /EFFECTIVE FEE \(BPS\): 100\.00 bps/);
  const unpriced = weekly.tooltip.formatter([{ dataIndex: 0, axisValue: '2026-11-02' }]);
  // The hover value equals the plotted bucket, with the gap disclosed.
  assert.match(unpriced, /FEES: \$140\.00/);
  assert.match(unpriced, /USD FEES MISSING ON 1\/7 DAYS · FEES ARE THE OBSERVED SUM/);
  assert.match(unpriced, /VOLUME: \$1,005,000\.00/);

  // A bucket with no priced day at all stays unavailable.
  const allNull = rows.map((row, index) => index < 7 ? { ...row, feesUsd: null, feeBps: null } : row);
  const nullWeek = buildStableSwapsOption(allNull, { analysis: { grain: 'week', hidden: [] } });
  const nullFees = nullWeek.series.find((item) => item.id === 'fees').data;
  assert.equal(nullFees[0], null);
  assert.equal(nullFees[1], 70);
  assert.equal(nullWeek.series.find((item) => item.id === 'feeBps').data[0], null);
  assert.match(nullWeek.tooltip.formatter([{ dataIndex: 0, axisValue: '2026-11-02' }]), /FEES: unavailable/);
});

test('rolling fee-rate averages use the same volume weighting with history lookback', () => {
  const rows = normalizeStableSwapsPayload(payload).days;
  const visible = rows.slice(7);
  // Mirrors TimeSeriesChart: history rows travel with the spec built from them.
  const option = buildStableSwapsOption(visible, {
    analysis: { grain: 'day', hidden: [], rolling: ['feeBps-7d', 'volume-7d'],
      historyRows: rows, historySpec: buildStableSwapsOption(rows, { hidden: [] })._spec }
  });
  const rate = option.series.find((item) => item.id === 'feeBps-7d').data;
  const volume = option.series.find((item) => item.id === 'volume-7d').data;
  // First visible day (index 7) looks back over days 1..7 from history.
  const lookback = rows.slice(1, 8);
  assert.equal(weightedStableSwapFeeBps(lookback), 100);
  assert.ok(Math.abs(rate[0] - weightedStableSwapFeeBps(lookback)) < 1e-9);
  // Days 0..6 include the $1m low-rate day, so the weighted average drops sharply.
  const fromStart = buildStableSwapsOption(rows, { analysis: { grain: 'day', hidden: [], rolling: ['feeBps-7d'] } })
    .series.find((item) => item.id === 'feeBps-7d').data;
  assert.equal(fromStart[5], null);
  assert.ok(Math.abs(fromStart[6] - weightedStableSwapFeeBps(rows.slice(0, 7))) < 1e-9);
  assert.ok(fromStart[6] < 2);
  assert.equal(volume[0], lookback.reduce((sum, row) => sum + row.volumeUsd, 0) / 7);

  // Fee rolling averages stay daily means (not sums) and keep the foundation's
  // gap rule: a 7-day window containing the unpriced day is unavailable.
  const feesRolling = buildStableSwapsOption(rows, { analysis: { grain: 'day', hidden: [], rolling: ['fees-7d'] } })
    .series.find((item) => item.id === 'fees-7d').data;
  assert.equal(feesRolling[11], null);
  assert.equal(feesRolling[12], 10);
  assert.equal(feesRolling[13], 10);
  const weeklyFeesRolling = buildStableSwapsOption(rows, { analysis: { grain: 'week', hidden: [], rolling: ['fees-7d'] } })
    .series.find((item) => item.id === 'fees-7d').data;
  assert.deepEqual(weeklyFeesRolling, [null, 10]);
});
