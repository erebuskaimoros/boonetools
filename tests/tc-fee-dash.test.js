import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateTcFeeRows,
  buildIncomeVolumeRollingAverageSeries,
  buildRollingAverageSeries,
  buildTcFeeChartSeries,
  computeFeesPerBillionUsd,
  computeIncomeVolumeBps,
  normalizeTcFeeRows,
  summarizeTcFeeRows
} from '../src/lib/tc-fee-dash/model.js';
import {
  buildSystemIncomeDistribution,
  formatSystemIncomePercent,
  systemIncomeDistributionFlows
} from '../src/lib/tc-fee-dash/distribution.js';

test('system income distribution resolves active Mimirs over protocol defaults', () => {
  const distribution = buildSystemIncomeDistribution({
    SYSTEMINCOMEBURNRATEBPS: 500,
    POLRESERVESYSTEMINCOMEBPS: 2000
  }, {
    int_64_values: {
      SystemIncomeBurnRateBps: 1,
      DevFundSystemIncomeBps: 500,
      TCYStakeSystemIncomeBps: 1000,
      MarketingFundSystemIncomeBps: 500,
      POLReserveSystemIncomeBps: 0
    }
  });

  assert.equal(distribution.complete, true);
  assert.equal(distribution.explicitBps, 4500);
  assert.equal(distribution.totalBps, 10_000);
  assert.equal(distribution.overflowBps, 0);
  assert.deepEqual(
    distribution.allocations.map(({ id, bps, source }) => ({ id, bps, source })),
    [
      { id: 'burn', bps: 500, source: 'mimir' },
      { id: 'dev', bps: 500, source: 'constant' },
      { id: 'tcy', bps: 1000, source: 'constant' },
      { id: 'marketing', bps: 500, source: 'constant' },
      { id: 'ip', bps: 5500, source: 'derived' },
      { id: 'pol', bps: 2000, source: 'mimir' }
    ]
  );
});

test('system income distribution accepts zero overrides and builds chart flows', () => {
  const distribution = buildSystemIncomeDistribution({
    systemincomeburnratebps: 0,
    devfundsystemincomebps: 500,
    tcystakesystemincomebps: 1000,
    marketingfundsystemincomebps: 500,
    polreservesystemincomebps: 0
  });

  assert.equal(distribution.allocations.find(({ id }) => id === 'burn').source, 'mimir');
  assert.equal(distribution.allocations.find(({ id }) => id === 'ip').bps, 8000);
  assert.deepEqual(systemIncomeDistributionFlows(distribution).map(({ to, flow }) => ({ to, flow })), [
    { to: 'DEV', flow: 5 },
    { to: 'TCY', flow: 10 },
    { to: 'MKT', flow: 5 },
    { to: 'BOND PROVIDERS', flow: 80 }
  ]);
  assert.equal(formatSystemIncomePercent(5), '5%');
  assert.equal(formatSystemIncomePercent(5.125), '5.13%');
  assert.equal(formatSystemIncomePercent(null), '—');
});

test('computeFeesPerBillionUsd normalizes fees against global exchange volume', () => {
  assert.equal(Math.round(computeFeesPerBillionUsd(375_700, 1_033_000_000_000)), 364);
});

test('computeIncomeVolumeBps normalizes liquidity fee income against THORChain volume', () => {
  assert.equal(computeIncomeVolumeBps(25_000, 10_000_000), 25);
  assert.equal(computeIncomeVolumeBps(0, 10_000_000), 0);
  assert.equal(computeIncomeVolumeBps(25_000, 0), null);
});

test('normalizeTcFeeRows computes metric values and sorts by window start', () => {
  const rows = normalizeTcFeeRows([
    {
      windowLabel: 'later',
      windowStart: '2025-11-18',
      period: 'day',
      tcFeesRune: 100_000,
      runePriceUsd: 3.104,
      tcFeesUsd: 310_400,
      cmcVolume24hUsd: 1_200_000_000_000,
      defillamaDexVolumeUsd: 103_000_000_000,
      globalExchangeVolumeUsd: 1_303_000_000_000,
      thorchainVolumeUsd: 40_000_000,
      feeBps: 10
    },
    {
      windowLabel: 'earlier',
      windowStart: '2025-09-02',
      tcFeesUsd: 375_700,
      globalExchangeVolumeUsd: 1_033_000_000_000,
      feeBps: 10
    }
  ]);

  assert.equal(rows[0].windowLabel, 'earlier');
  assert.equal(rows[1].windowLabel, 'later');
  assert.equal(rows[1].period, 'day');
  assert.equal(rows[1].tcFeesRune, 100_000);
  assert.equal(rows[1].runePriceUsd, 3.104);
  assert.equal(rows[1].cmcVolume24hUsd, 1_200_000_000_000);
  assert.equal(rows[1].defillamaDexVolumeUsd, 103_000_000_000);
  assert.equal(rows[1].thorchainVolumeUsd, 40_000_000);
  assert.ok(Math.abs(rows[1].incomeVolumeBps - 77.6) < 0.00000001);
  assert.equal(Math.round(rows[0].feesPerBillionUsd), 364);
});

test('buildTcFeeChartSeries returns aligned labels and data arrays', () => {
  const series = buildTcFeeChartSeries([
    {
      windowLabel: 'Sep 2-Sep 9',
      windowStart: '2025-09-02',
      tcFeesUsd: 375_700,
      globalExchangeVolumeUsd: 1_033_000_000_000,
      thorchainVolumeUsd: 20_000_000,
      feeBps: 10,
      dailyMedianFeesPerBillionUsd: 273
    }
  ]);

  assert.deepEqual(series.labels, ['Sep 2-Sep 9']);
  assert.deepEqual(series.feeBps, [10]);
  assert.equal(Math.round(series.feesPerBillionUsd[0]), 364);
  assert.equal(series.incomeVolumeBps[0], 187.85);
  assert.equal(series.dailyMedianFeesPerBillionUsd[0], 273);
});

test('normalizeTcFeeRows keeps May/June 2026 zero-fee halt days visible', () => {
  const rows = normalizeTcFeeRows([
    {
      windowLabel: 'May 16',
      windowStart: '2026-05-16',
      windowEnd: '2026-05-17',
      period: 'day',
      tcFeesUsd: 0,
      globalExchangeVolumeUsd: 100_000_000_000
    },
    {
      windowLabel: 'Jul 1',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-02',
      period: 'day',
      tcFeesUsd: 0,
      globalExchangeVolumeUsd: 100_000_000_000
    }
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].feesPerBillionUsd, 0);
  assert.equal(rows[0].rollingAverageExcluded, true);
  assert.equal(rows[0].hasHaltDays, true);
  assert.equal(rows[0].haltLabel, 'Chain halt');
  assert.equal(rows[1].rollingAverageExcluded, false);
  assert.equal(rows[1].hasHaltDays, false);
});

test('buildTcFeeChartSeries exposes contiguous halt bands', () => {
  const series = buildTcFeeChartSeries([
    {
      windowLabel: 'May 15',
      windowStart: '2026-05-15',
      windowEnd: '2026-05-16',
      period: 'day',
      tcFeesUsd: 100,
      globalExchangeVolumeUsd: 1000,
      thorchainVolumeUsd: 100
    },
    {
      windowLabel: 'May 16',
      windowStart: '2026-05-16',
      windowEnd: '2026-05-17',
      period: 'day',
      tcFeesUsd: 0,
      globalExchangeVolumeUsd: 1000,
      thorchainVolumeUsd: 300
    },
    {
      windowLabel: 'May 17',
      windowStart: '2026-05-17',
      windowEnd: '2026-05-18',
      period: 'day',
      tcFeesUsd: 0,
      globalExchangeVolumeUsd: 1000
    },
    {
      windowLabel: 'Jun 22',
      windowStart: '2026-06-22',
      windowEnd: '2026-06-23',
      period: 'day',
      tcFeesUsd: 300,
      globalExchangeVolumeUsd: 1000
    }
  ]);

  assert.deepEqual(series.haltBands, [{
    startIndex: 1,
    endIndex: 2,
    label: 'Chain halt'
  }]);
});

test('aggregateTcFeeRows groups daily rows into weighted weekly and monthly buckets', () => {
  const rows = [
    {
      period: 'day',
      windowLabel: 'Jun 22',
      windowStart: '2022-06-22',
      windowEnd: '2022-06-23',
      tcFeesRune: 100,
      runePriceUsd: 2,
      tcFeesUsd: 200,
      cmcVolume24hUsd: 900,
      defillamaDexVolumeUsd: 100,
      globalExchangeVolumeUsd: 1000,
      thorchainVolumeUsd: 100
    },
    {
      period: 'day',
      windowLabel: 'Jun 23',
      windowStart: '2022-06-23',
      windowEnd: '2022-06-24',
      tcFeesRune: 300,
      runePriceUsd: 2,
      tcFeesUsd: 600,
      cmcVolume24hUsd: 100,
      defillamaDexVolumeUsd: 900,
      globalExchangeVolumeUsd: 1000,
      thorchainVolumeUsd: 300
    },
    {
      period: 'day',
      windowLabel: 'Jul 1',
      windowStart: '2022-07-01',
      windowEnd: '2022-07-02',
      tcFeesRune: 500,
      runePriceUsd: 2,
      tcFeesUsd: 1000,
      cmcVolume24hUsd: 1500,
      defillamaDexVolumeUsd: 500,
      globalExchangeVolumeUsd: 2000,
      thorchainVolumeUsd: 600
    }
  ];

  const weekly = aggregateTcFeeRows(rows, 'week');
  const monthly = aggregateTcFeeRows(rows, 'month');

  assert.equal(weekly.length, 2);
  assert.equal(weekly[0].windowStart, '2022-06-20');
  assert.equal(weekly[0].tcFeesUsd, 800);
  assert.equal(weekly[0].globalExchangeVolumeUsd, 2000);
  assert.equal(weekly[0].thorchainVolumeUsd, 400);
  assert.equal(weekly[0].incomeVolumeBps, 20_000);
  assert.equal(Math.round(weekly[0].feesPerBillionUsd), 400_000_000);
  assert.equal(weekly[0].cmcVolume24hUsd, 1000);
  assert.equal(weekly[0].defillamaDexVolumeUsd, 1000);

  assert.equal(monthly.length, 2);
  assert.equal(monthly[0].windowLabel, 'Jun 2022');
  assert.equal(monthly[0].tcFeesUsd, 800);
  assert.equal(monthly[1].windowLabel, 'Jul 2022');
  assert.equal(monthly[1].tcFeesUsd, 1000);
});

test('buildRollingAverageSeries uses trailing daily source rows for target windows', () => {
  const sourceRows = [
    {
      period: 'day',
      windowLabel: 'Jan 1',
      windowStart: '2024-01-01',
      windowEnd: '2024-01-02',
      tcFeesUsd: 100,
      globalExchangeVolumeUsd: 1000
    },
    {
      period: 'day',
      windowLabel: 'Jan 2',
      windowStart: '2024-01-02',
      windowEnd: '2024-01-03',
      tcFeesUsd: 200,
      globalExchangeVolumeUsd: 1000
    },
    {
      period: 'day',
      windowLabel: 'Jan 3',
      windowStart: '2024-01-03',
      windowEnd: '2024-01-04',
      tcFeesUsd: 600,
      globalExchangeVolumeUsd: 3000
    },
    {
      period: 'day',
      windowLabel: 'Jan 4',
      windowStart: '2024-01-04',
      windowEnd: '2024-01-05',
      tcFeesUsd: 1000,
      globalExchangeVolumeUsd: 1000
    }
  ];
  const targetRows = [
    {
      period: 'week',
      windowLabel: 'Jan 1-Jan 4',
      windowStart: '2024-01-01',
      windowEnd: '2024-01-05',
      tcFeesUsd: 1900,
      globalExchangeVolumeUsd: 6000
    }
  ];

  const dailySeries = buildRollingAverageSeries(sourceRows, sourceRows, 2);
  const weeklySeries = buildRollingAverageSeries(sourceRows, targetRows, 2);

  assert.equal(Math.round(dailySeries[0]), 100_000_000);
  assert.equal(Math.round(dailySeries[1]), 150_000_000);
  assert.equal(Math.round(dailySeries[3]), 400_000_000);
  assert.equal(Math.round(weeklySeries[0]), 400_000_000);
});

test('buildIncomeVolumeRollingAverageSeries weights trailing income by THORChain volume', () => {
  const rows = [
    {
      period: 'day',
      windowLabel: 'Jan 1',
      windowStart: '2024-01-01',
      windowEnd: '2024-01-02',
      tcFeesUsd: 100,
      globalExchangeVolumeUsd: 1000,
      thorchainVolumeUsd: 1000
    },
    {
      period: 'day',
      windowLabel: 'Jan 2',
      windowStart: '2024-01-02',
      windowEnd: '2024-01-03',
      tcFeesUsd: 300,
      globalExchangeVolumeUsd: 1000,
      thorchainVolumeUsd: 3000
    }
  ];

  const rolling = buildIncomeVolumeRollingAverageSeries(rows, rows, 2);
  assert.equal(rolling[0], 1000);
  assert.equal(rolling[1], 1000);
});

test('buildRollingAverageSeries excludes May/June 2026 halt days', () => {
  const rows = [
    {
      period: 'day',
      windowLabel: 'May 15',
      windowStart: '2026-05-15',
      windowEnd: '2026-05-16',
      tcFeesUsd: 100,
      globalExchangeVolumeUsd: 1000
    },
    {
      period: 'day',
      windowLabel: 'May 16',
      windowStart: '2026-05-16',
      windowEnd: '2026-05-17',
      tcFeesUsd: 0,
      globalExchangeVolumeUsd: 1000
    },
    {
      period: 'day',
      windowLabel: 'Jun 22',
      windowStart: '2026-06-22',
      windowEnd: '2026-06-23',
      tcFeesUsd: 300,
      globalExchangeVolumeUsd: 1000
    }
  ];

  const series = buildRollingAverageSeries(rows, rows, 60);

  assert.equal(Math.round(series[2]), 200_000_000);
});

test('summarizeTcFeeRows returns weighted aggregate and peak window', () => {
  const summary = summarizeTcFeeRows([
    {
      windowLabel: 'low',
      windowStart: '2025-09-23',
      tcFeesUsd: 103_500,
      globalExchangeVolumeUsd: 1_242_000_000_000,
      feeBps: 1
    },
    {
      windowLabel: 'high',
      windowStart: '2025-09-30',
      tcFeesUsd: 749_000,
      globalExchangeVolumeUsd: 1_479_000_000_000,
      feeBps: 15
    }
  ]);

  assert.equal(summary.windowCount, 2);
  assert.equal(summary.totalTcFeesUsd, 852_500);
  assert.equal(summary.peak.windowLabel, 'high');
  assert.equal(Math.round(summary.weightedFeesPerBillionUsd), 313);
});
