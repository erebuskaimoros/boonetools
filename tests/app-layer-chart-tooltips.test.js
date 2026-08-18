import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAccruedValueTooltipDetails,
  buildPolAccrualTooltipDetails
} from '../src/lib/app-layer/chart-tooltips.js';

test('01 + 03 supplemental tooltip rows do not repeat a dataset value', () => {
  assert.deepEqual(buildAccruedValueTooltipDetails({
    inflow_usd: 76.98,
    liquidity_fee_usd: 148.18,
    accrued_value_usd: 225.16
  }), [
    'TC-retained 01 + 03: $225.16'
  ]);
});

test('POL supplemental tooltip rows do not repeat the POL dataset value', () => {
  const row = {
    bucket_start: '2026-08-15',
    gross_inflow_usd: 73.15494792232852,
    post_cutover_gross_usd: 73.15494792232852,
    pol_accrued_usd: 24.384982640776173
  };

  assert.deepEqual(buildPolAccrualTooltipDetails(row, 'daily'), [
    'Allocation: 1/3 of post-cutover accrual'
  ]);
  assert.deepEqual(buildPolAccrualTooltipDetails(row, 'weekly'), [
    'Post-cutover gross in this week: $73.15',
    'Allocation: 1/3 of post-cutover accrual'
  ]);
});
