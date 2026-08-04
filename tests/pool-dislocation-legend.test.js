import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const componentSource = readFileSync(
  new URL('../src/lib/PoolDislocation.svelte', import.meta.url),
  'utf8'
);

function sourceBetween(startMarker, endMarker) {
  const start = componentSource.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);

  const end = componentSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return componentSource.slice(start, end);
}

test('raw pool-dislocation legend keys do not hide enabled rolling averages', () => {
  const rollingScale = sourceBetween(
    '$: rollingAverageScalePoints =',
    '$: visibleChartPoints ='
  );
  const rollingPaths = sourceBetween(
    '{#each rollingAveragePaths as series}',
    '{#each chartPoints as point, index}'
  );
  const rollingTooltip = sourceBetween(
    '{#each hoverRollingAverages as average}',
    '{/each}'
  );

  for (const [area, source] of [
    ['chart scale', rollingScale],
    ['rendered paths', rollingPaths],
    ['hover tooltip', rollingTooltip]
  ]) {
    assert.doesNotMatch(
      source,
      /(?:oracle|binance)TrendVisible/,
      `${area} must remain independent from raw trend legend visibility`
    );
  }
});
