import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPoolAnalysisRows, POOL_ANALYSIS_TABLE_PERIODS } from '../src/shared/pool-analysis.js';

function tableRow({ balance = '100000000000', volume = '20000000000', fees = '20000000' } = {}) {
  return buildPoolAnalysisRows({
    pools: [{ asset: 'BTC.BTC', status: 'Available', balance_rune: balance, balance_asset: '100000000' }],
    oraclePayload: { prices: [{ symbol: 'RUNE', price: '2' }] },
    aggregates: POOL_ANALYSIS_TABLE_PERIODS.map(({ id, days }) => ({
      asset: 'BTC.BTC', period_id: id, period_days: days, observed_days: days,
      volume_rune_e8: volume === null ? null : String(BigInt(volume) * BigInt(days)),
      fees_rune_e8: fees === null ? null : String(BigInt(fees) * BigInt(days)),
      volume_usd: volume === null ? null : Number(volume) / 1e8 * 2 * days,
      fees_usd: fees === null ? null : Number(fees) / 1e8 * 2 * days
    }))
  })[0];
}

test('table volume/depth compares the full selected period with current two-sided depth', () => {
  const row = tableRow();
  for (const { id, days } of POOL_ANALYSIS_TABLE_PERIODS) {
    const metric = row.period_metrics[id];
    // 200 RUNE of daily volume / 2,000 RUNE of current liquidity = 10% per day.
    assert.ok(Math.abs(metric.volume_depth_percent - 10 * days) < 1e-9,
      `${id}: expected ${10 * days}%, received ${metric.volume_depth_percent}%`);
  }
  assert.equal(row.volume_depth_percent, row.period_metrics['30d'].volume_depth_percent,
    'legacy summary fields must describe the same default 30-day period');
});

test('observed zero fees remain zero in fee ratios and APR', () => {
  const row = tableRow({ fees: '0' });
  for (const metric of Object.values(row.period_metrics)) {
    assert.equal(metric.fee_depth_percent, 0);
    assert.equal(metric.fee_volume_percent, 0);
    assert.equal(metric.annualized_fee_rate_percent, 0);
  }
});

test('observed zero volume has zero turnover but an undefined fee/volume ratio', () => {
  const metric = tableRow({ volume: '0', fees: '0' }).period_metrics['24h'];
  assert.equal(metric.volume_depth_percent, 0);
  assert.equal(metric.fee_depth_percent, 0);
  assert.equal(metric.fee_volume_percent, null);
});

test('missing activity and empty liquidity do not fabricate ratios', () => {
  const missing = tableRow({ volume: null, fees: null }).period_metrics['24h'];
  for (const name of ['volume_depth_percent', 'fee_depth_percent', 'fee_volume_percent', 'annualized_fee_rate_percent']) {
    assert.equal(missing[name], null, name);
  }
  const empty = tableRow({ balance: '0' }).period_metrics['24h'];
  for (const name of ['volume_depth_percent', 'fee_depth_percent', 'annualized_fee_rate_percent']) {
    assert.equal(empty[name], null, name);
  }
});
