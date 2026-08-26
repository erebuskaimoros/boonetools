import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dashboardSource = await readFile(
  new URL('../src/lib/AppLayerBaseLayerDashboard.svelte', import.meta.url),
  'utf8'
);

function sliceElementFrom(marker, closingTag) {
  const markerIndex = dashboardSource.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing dashboard marker: ${marker}`);
  const openingIndex = dashboardSource.lastIndexOf(`<${closingTag}`, markerIndex);
  const closingIndex = dashboardSource.indexOf(`</${closingTag}>`, markerIndex);
  assert.notEqual(openingIndex, -1, `missing opening ${closingTag} for ${marker}`);
  assert.notEqual(closingIndex, -1, `missing closing ${closingTag} for ${marker}`);
  return dashboardSource.slice(openingIndex, closingIndex + closingTag.length + 3);
}

test('top POL cards summarize observed settlement while the POL chart remains accrual-based', () => {
  const flowCard = sliceElementFrom('href="#chart-pol"', 'a');
  const realizedValueCard = sliceElementFrom('benefit-hero-leg amber separate', 'div');
  const metricCard = sliceElementFrom('metric-idx pol-i', 'article');
  const chartStart = dashboardSource.indexOf('<!-- ============ P POL CAPITAL ============ -->');
  const chartEnd = dashboardSource.indexOf('<!-- ============ 03 GENERATED ============ -->');
  const polChart = dashboardSource.slice(chartStart, chartEnd);

  for (const card of [flowCard, realizedValueCard, metricCard]) {
    assert.match(card, /totalPolPaidUsd/);
    assert.doesNotMatch(card, /totalPolAccruedUsd/);
    assert.match(card, /settled/i);
    assert.doesNotMatch(card, /accrued/i);
  }

  assert.match(polChart, /totalPolAccruedUsd/);
  assert.match(polChart, /pol_accrued_usd/);
});
