import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runChartsInTimeZone(timeZone, swaps, midgardHistory) {
  const script = `
    import { computeDailyData } from './src/lib/rapid-swaps/charts.js';

    const swaps = ${JSON.stringify(swaps)};
    const midgardHistory = ${JSON.stringify(midgardHistory)};

    console.log(JSON.stringify(computeDailyData(swaps, midgardHistory)));
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

test('computeDailyData matches rapid swaps to the same UTC day as Midgard history', () => {
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

  assert.deepEqual(result.labels, ['Mar 29']);
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
          startTime: '1774742400',
          totalVolumeUSD: '19800',
          totalCount: '10'
        }
      ]
    }
  );

  assert.deepEqual(result.volume, [100]);
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
          startTime: '1774742400',
          totalVolumeUSD: '10000',
          totalCount: '10'
        }
      ]
    }
  );

  assert.deepEqual(result.volumePct, [100]);
});
