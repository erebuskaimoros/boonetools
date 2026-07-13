import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const artifactUrl = new URL(
  '../public/data/rujira-base-layer-fees/rujira-base-layer-inflows.json',
  import.meta.url
);
const artifact = JSON.parse(await readFile(artifactUrl, 'utf8'));

test('Base Layer earnings artifact uses the weighted routable collector boundary', () => {
  assert.equal(artifact.meta.method, 'weighted-routable-balance-delta');
  assert.deepEqual(
    artifact.meta.routeScopes.map(({ key, baseLayerShare }) => ({ key, baseLayerShare })),
    [
      { key: 'trade', baseLayerShare: 0.5 },
      { key: 'core', baseLayerShare: 0.5 },
      { key: 'base', baseLayerShare: 1 }
    ]
  );
});

test('each daily Base Layer earnings bar reconciles to its denom movements', () => {
  for (const row of artifact.daily) {
    const denomUsd = Object.values(row.by_denom).reduce((sum, entry) => sum + entry.usd, 0);
    assert.ok(
      Math.abs(denomUsd - row.inflow_usd) < 1e-8,
      `${row.day_start}: denom total ${denomUsd} != earnings ${row.inflow_usd}`
    );
  }
});

test('each weekly Base Layer earnings bar is the sum of its daily rows', () => {
  for (const week of artifact.weekly) {
    const dailyUsd = artifact.daily
      .filter((day) => day.day_start >= week.week_start && day.day_start < week.week_end)
      .reduce((sum, day) => sum + day.inflow_usd, 0);
    assert.ok(
      Math.abs(dailyUsd - week.inflow_usd) < 1e-8,
      `${week.week_start}: daily total ${dailyUsd} != weekly earnings ${week.inflow_usd}`
    );
  }
});
