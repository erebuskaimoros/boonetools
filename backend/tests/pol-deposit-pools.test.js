import assert from 'node:assert/strict';
import test from 'node:test';
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
const { buildSystemIncomePolReadModel, applySystemIncomePolLiveOverlay } = await import('../src/shared/system-income-pol.js');
const { loadSystemIncomePolLiveOverlay } = await import('../src/shared/system-income-pol-store.js');

test('read model publishes exact daily pool flows including recipients without current positions', async () => {
  const { payload } = await buildSystemIncomePolReadModel({}, {
    now: new Date('2026-09-02T12:00:00Z'),
    loadDaily: async () => [
      { day: '2026-09-01', deployed_e8: '9007199254741000' },
      { day: '2026-09-02', deployed_e8: '0' }
    ],
    loadPoolDaily: async () => [
      { day: '2026-09-01', asset: 'XRP.XRP', deployed_e8: '7' },
      { day: '2026-09-01', asset: 'TRON.USDT', deployed_e8: '9007199254740993' }
    ],
    loadPoolHourly: async () => [], loadPositions: async () => [], loadState: async () => ({})
  });
  assert.equal(payload.schema_version, 6);
  assert.deepEqual(payload.daily[0].pool_deposits, [
    { asset: 'TRON.USDT', deployed_e8: '9007199254740993' }, { asset: 'XRP.XRP', deployed_e8: '7' }
  ]);
  assert.equal(payload.daily[0].pool_deposits.reduce((sum, pool) => sum + BigInt(pool.deployed_e8), 0n).toString(), payload.daily[0].deployed_e8);
  assert.deepEqual(payload.daily[1].pool_deposits, []);
});

test('live overlay preserves each UTC day and combines multiple deployments to the same pool', async () => {
  const overlay = await loadSystemIncomePolLiveOverlay({ query: async () => ({ rows: [
    { height: '11', block_time: '2026-09-01T23:59:58Z', system_income_total_e8: '10', system_income_pol_reward_e8: '2', system_income_pol_deployments: [{ asset: 'TRON.USDT', runeE8: '3' }] },
    { height: '12', block_time: '2026-09-01T23:59:59Z', system_income_total_e8: '10', system_income_pol_reward_e8: '2', system_income_pol_deployments: [{ asset: 'TRON.USDT', runeE8: '4' }] },
    { height: '13', block_time: '2026-09-02T00:00:01Z', system_income_total_e8: '20', system_income_pol_reward_e8: '4', system_income_pol_deployments: [{ asset: 'XRP.XRP', runeE8: '5' }] }
  ] }) }, 10);
  assert.equal(overlay.daily.length, 2);
  const initial = { live: { through_height: 10 }, summary: { total_deployed_e8: '10', total_funded_e8: '10', total_system_income_e8: '100' }, daily: [
    { day: '2026-09-01', deployed_e8: '10', cumulative_deployed_e8: '10', funded_e8: '10', system_income_e8: '100', rune_price_usd: '2', pool_deposits: [{ asset: 'TRON.USDT', deployed_e8: '10' }] }
  ] };
  const result = applySystemIncomePolLiveOverlay(initial, overlay);
  assert.deepEqual(result.daily.map(row => row.deployed_e8), ['17', '5']);
  assert.deepEqual(result.daily.map(row => row.pool_deposits), [
    [{ asset: 'TRON.USDT', deployed_e8: '17' }], [{ asset: 'XRP.XRP', deployed_e8: '5' }]
  ]);
  assert.deepEqual(result.daily.map(row => row.cumulative_deployed_e8), ['17', '22']);
  assert.equal(result.daily[1].rune_price_usd, null);
  assert.equal(result.summary.total_deployed_e8, '22');
  assert.equal(initial.daily[0].pool_deposits[0].deployed_e8, '10');
  assert.equal(result.live.through_height, 13);
});

test('an empty overlay does not mark historical data partial or erase known income', async () => {
  const initial = { daily: [{ day: '2026-09-01', partial: false }], summary: { total_system_income_e8: '100' } };
  const overlay = await loadSystemIncomePolLiveOverlay({ query: async () => ({ rows: [] }) }, 10);
  assert.deepEqual(applySystemIncomePolLiveOverlay(initial, overlay), initial);
});
