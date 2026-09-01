import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { tcFeeNavigatorIndexFromPixel } from '../src/lib/tc-fee-dash/charts.js';
import {
  formatTcFeeBps,
  formatTcFeeDate,
  formatTcFeeUsdCompact,
  tcFeePointColor
} from '../src/lib/tc-fee-dash/presentation.js';

test('TC fee presentation formatting is shared by charts and metrics', () => {
  assert.equal(formatTcFeeUsdCompact(1_250_000_000), '$1.25B');
  assert.equal(formatTcFeeUsdCompact(2_500_000_000_000), '$2.5T');
  assert.equal(formatTcFeeBps(12.345), '12.35 bps');
  assert.equal(formatTcFeeBps(null), '0 bps');
  assert.equal(formatTcFeeDate('2026-07-17'), 'Jul 17, 2026');
});

test('TC fee chart primitives keep halt colors and navigator bounds stable', () => {
  assert.equal(tcFeePointColor({ hasHaltDays: true, feeBps: 0 }), '#d4a017');
  assert.equal(tcFeePointColor(16), '#00cc66');
  assert.equal(tcFeePointColor(3), '#dc3545');
  assert.equal(tcFeeNavigatorIndexFromPixel(-10, 100, 11), 0);
  assert.equal(tcFeeNavigatorIndexFromPixel(50, 100, 11), 5);
  assert.equal(tcFeeNavigatorIndexFromPixel(120, 100, 11), 10);
});

test('TC fee dashboard renders two current system-income distribution cards', async () => {
  const source = await readFile(new URL('../src/lib/TCFeeDash.svelte', import.meta.url), 'utf8');

  assert.match(source, /SYSTEM INCOME DISTRIBUTION/);
  assert.match(source, /05A[\s\S]*ACTIVE ALLOCATION/);
  assert.match(source, /05B[\s\S]*DISTRIBUTION FLOW/);
  assert.match(source, /buildSystemIncomeDistribution/);
  assert.match(source, /createSystemIncomeDistributionChart/);
});
