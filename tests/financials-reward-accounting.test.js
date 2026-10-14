import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinancialsPoints } from '../shared/financials/model.js';
import { financialEChartsTooltip } from '../src/lib/financials/echarts-options.js';

// Liquify Midgard's completed 2026-10-11 bucket. Its signed residual is
// not Reserve emissions: REVSHARE has already reduced reported earnings.
const from = Date.parse('2026-10-11T00:00:00Z') / 1000;
const earnings = [{ startTime: String(from), endTime: String(from + 86400),
  earnings: '9269863863884', liquidityFees: '9309387704376',
  blockRewards: '-39523840492', bondingEarnings: '4790544093347',
  runePriceUSD: '0.7008449051337723' }];

test('a negative Midgard remainder is never presented as Reserve emissions or block rewards', () => {
  const [point] = buildFinancialsPoints({ from, to: from + 86400, earnings });
  const tooltip = financialEChartsTooltip(point, 'rune');
  assert.doesNotMatch(tooltip, /Block rewards:/);
  assert.match(tooltip, /Reserve emissions:/);
  assert.match(tooltip, /REVSHARE:/);
  assert.equal(point.reserveEmissionsRune, null, 'missing emission evidence must stay unavailable');
  assert.equal(point.revshareRune, null, 'missing payout evidence must not become zero');
  assert.equal(point.incomeRune, 92698.63863884, 'retained earnings must not silently become gross fees');
});
