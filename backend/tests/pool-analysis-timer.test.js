import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handlePoolAnalysis } from '../src/handlers/pool-analysis.js';
import { POOL_ANALYSIS_TTL_MS } from '../src/shared/pool-analysis.js';

const MINUTE = 60_000;
const QUARTER = 15 * MINUTE;
const timer = Object.fromEntries(readFileSync(new URL('../../ops/systemd/boonetools-pool-analysis.timer', import.meta.url), 'utf8')
  .split('\n').filter((line) => /^[A-Za-z]+=/.test(line)).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));

function duration(value) {
  const match = /^(\d+)(s|min)$/.exec(value);
  assert.ok(match, `Unsupported timer duration: ${value}`);
  return Number(match[1]) * (match[2] === 'min' ? MINUTE : 1000);
}

// Model both the old monotonic timer and the quarter-hour UTC calendar contract.
// The deployed calendar syntax is additionally checked with systemd-analyze.
function scheduledRuns(activatedAt, through) {
  const runs = [];
  if (timer.OnCalendar) {
    const match = /^\*-\*-\* \*:(\d{1,2}\/15|\d{2}(?:,\d{2}){3}):00 UTC$/.exec(timer.OnCalendar);
    assert.ok(match, 'Use an explicit UTC quarter-hour calendar');
    const minutes = match[1].includes('/')
      ? Array.from({ length: 4 }, (_, index) => Number(match[1].split('/')[0]) + index * 15)
      : match[1].split(',').map(Number);
    assert.ok(minutes.every((minute) => minute >= 0 && minute < 60));
    for (let hour = Math.floor(activatedAt / (60 * MINUTE)) * 60 * MINUTE; hour <= through; hour += 60 * MINUTE) {
      for (const minute of minutes) {
        const run = hour + minute * MINUTE;
        if (run >= activatedAt && run <= through) runs.push(run);
      }
    }
  } else {
    for (let run = activatedAt + duration(timer.OnActiveSec); run <= through; run += duration(timer.OnUnitActiveSec)) runs.push(run);
  }
  return runs;
}

async function responseAt(run, now, sourceLag = 0) {
  const windowEnd = Math.floor((run - sourceLag) / QUARTER) * QUARTER;
  return handlePoolAnalysis(null, null, {
    now,
    getReadModel: async () => ({ stale: false, payload: {
      period: { mode: 'bucketed' },
      pools: [{ asset: 'BTC.BTC', period_metrics: {
        '24h': { window_mode: 'rolling', window_end: new Date(windowEnd).toISOString(), stale: false }
      } }]
    } })
  });
}

test('healthy scheduled refreshes avoid the observed 03:43 run / 03:56 stale gap', async () => {
  const observedAt = Date.parse('2026-10-21T03:56:55Z');
  const runs = scheduledRuns(Date.parse('2026-10-21T03:41:49Z'), observedAt);
  assert.ok(runs.length);
  const response = await responseAt(runs.at(-1), observedAt);
  assert.equal(response.body.stale, false, 'A successful regular refresh must not expire before the next scheduled refresh');
});

test('quarter-hour alignment survives arbitrary timer activation and has no duplicate startup trigger', () => {
  assert.ok(timer.OnCalendar, 'Relative activation can permanently shift every refresh away from source boundaries');
  for (const key of ['OnActiveSec', 'OnBootSec', 'OnStartupSec', 'OnUnitActiveSec', 'OnUnitInactiveSec', 'RandomizedDelaySec']) {
    assert.equal(timer[key], undefined, `${key} must not add or shift provider requests`);
  }
  assert.equal(timer.Persistent, 'true', 'Resume with one calendar catch-up after downtime');
  assert.equal(timer.Unit, 'boonetools-pool-analysis.service');
  const midnight = Date.parse('2026-10-21T00:00:00Z');
  const expected = scheduledRuns(midnight, midnight + 60 * MINUTE);
  assert.equal(expected.length, 4, 'Keep four scheduled runs per hour');
  for (let phase = 0; phase < 15; phase++) {
    const activatedAt = midnight + phase * MINUTE + 19_000;
    assert.deepEqual(scheduledRuns(activatedAt, midnight + 60 * MINUTE), expected.filter((run) => run >= activatedAt));
  }
});

test('source windows stay fresh through the next publication with aggregation lag and scheduler/runtime headroom', async () => {
  assert.equal(POOL_ANALYSIS_TTL_MS, 20 * MINUTE, 'Do not conceal delayed data by widening freshness');
  const runs = scheduledRuns(Date.parse('2026-10-20T23:41:49Z'), Date.parse('2026-10-22T00:00:00Z'));
  const sourceLag = 90_000;
  const runtime = 90_000;
  const accuracy = duration(timer.AccuracySec);
  for (let index = 1; index < runs.length; index++) {
    assert.equal(runs[index] - runs[index - 1], QUARTER);
    // Previous run starts on time; next run takes the full allowed timer slack
    // and a conservative 90-second runtime before replacing that observation.
    const beforePublication = runs[index] + accuracy + runtime - 1;
    const response = await responseAt(runs[index - 1], beforePublication, sourceLag);
    assert.equal(response.body.stale, false, `Freshness gap before ${new Date(beforePublication).toISOString()}`);
  }
});
