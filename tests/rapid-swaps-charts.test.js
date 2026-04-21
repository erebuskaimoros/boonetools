import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSeriesAxisBounds } from '../src/lib/rapid-swaps/charts.js';

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runChartsInTimeZone(timeZone, swaps, midgardHistory, allSwaps = swaps) {
  const script = `
    import { computeDailyData } from './src/lib/rapid-swaps/charts.js';

    const swaps = ${JSON.stringify(swaps)};
    const midgardHistory = ${JSON.stringify(midgardHistory)};
    const allSwaps = ${JSON.stringify(allSwaps)};

    console.log(JSON.stringify(computeDailyData(swaps, midgardHistory, allSwaps)));
  `;

  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: websiteRoot,
    env: {
      ...process.env,
      TZ: timeZone
    }
  });

  return JSON.parse(stdout.toString());
}

test('computeDailyData groups rapid swaps and Midgard history by the same local day', () => {
  const result = runChartsInTimeZone(
    'America/New_York',
    [
      {
        action_date: '2026-03-29T00:30:00.000Z',
        input_estimated_usd: 100,
        streaming_count: 4,
        blocks_used: 2
      }
    ],
    {
      intervals: [
        {
          startTime: '1774742400',
          totalVolumeUSD: '10000',
          totalCount: '10'
        }
      ]
    }
  );

  assert.deepEqual(result.labels, ['Mar 28']);
  assert.deepEqual(result.volumePct, [100]);
  assert.deepEqual(result.countPct, [10]);
});

test('computeDailyData uses both swap legs for non-RUNE adoption volume', () => {
  const result = runChartsInTimeZone(
    'UTC',
    [
      {
        action_date: '2026-03-29T12:00:00.000Z',
        source_asset: 'BTC.BTC',
        target_asset: 'ETH.ETH',
        input_estimated_usd: 100,
        output_estimated_usd: 98,
        streaming_count: 4,
        blocks_used: 2
      }
    ],
    {
      intervals: [
        {
          startTime: '1774785600',
          totalVolumeUSD: '19800',
          totalCount: '10'
        }
      ]
    }
  );

  assert.deepEqual(result.volume, [198]);
  assert.deepEqual(result.cumVolume, [198]);
  assert.deepEqual(result.volumePct, [100]);
});

test('computeDailyData keeps RUNE-paired adoption volume single-leg', () => {
  const result = runChartsInTimeZone(
    'UTC',
    [
      {
        action_date: '2026-03-29T12:00:00.000Z',
        source_asset: 'THOR.RUNE',
        target_asset: 'ETH.ETH',
        input_estimated_usd: 100,
        output_estimated_usd: 99,
        streaming_count: 4,
        blocks_used: 2
      }
    ],
    {
      intervals: [
        {
          startTime: '1774785600',
          totalVolumeUSD: '10000',
          totalCount: '10'
        }
      ]
    }
  );

  assert.deepEqual(result.volumePct, [100]);
});

test('computeDailyData seeds cumulative totals from swaps before the visible window', () => {
  const allSwaps = [
    {
      action_date: '2026-03-27T12:00:00.000Z',
      source_asset: 'BTC.BTC',
      target_asset: 'ETH.ETH',
      input_estimated_usd: 50,
      output_estimated_usd: 49,
      streaming_count: 3,
      blocks_used: 2
    },
    {
      action_date: '2026-03-28T12:00:00.000Z',
      source_asset: 'THOR.RUNE',
      target_asset: 'ETH.ETH',
      input_estimated_usd: 100,
      output_estimated_usd: 99,
      streaming_count: 4,
      blocks_used: 2
    },
    {
      action_date: '2026-03-29T12:00:00.000Z',
      source_asset: 'BTC.BTC',
      target_asset: 'ETH.ETH',
      input_estimated_usd: 150,
      output_estimated_usd: 148,
      streaming_count: 6,
      blocks_used: 3
    }
  ];

  const result = runChartsInTimeZone('UTC', allSwaps.slice(1), null, allSwaps);

  assert.deepEqual(result.count, [1, 1]);
  assert.deepEqual(result.cumCount, [2, 3]);
  assert.deepEqual(result.volume, [100, 298]);
  assert.deepEqual(result.cumVolume, [199, 497]);
});

test('getSeriesAxisBounds keeps cumulative axes off zero when the visible range is already positive', () => {
  const result = getSeriesAxisBounds([199, 497], {
    clampMin: 0,
    minSpan: 1
  });

  assert.ok(result.min > 0);
  assert.ok(result.max > 497);
});

test('getSeriesAxisBounds preserves integer cumulative count bounds', () => {
  const result = getSeriesAxisBounds([42, 43, 44], {
    clampMin: 0,
    minSpan: 1,
    roundToInteger: true
  });

  assert.equal(Number.isInteger(result.min), true);
  assert.equal(Number.isInteger(result.max), true);
  assert.ok(result.min > 0);
  assert.ok(result.max >= 45);
});
