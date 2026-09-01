import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';

const {
  parseSystemIncomePolEvents,
  parseSystemIncomePolRpcBlock
} = await import('../src/shared/system-income-pol-blocks.js');
const {
  buildSystemIncomePolPositionRows,
  reconcileSystemIncomePolState
} = await import('../src/shared/system-income-pol-reconciliation.js');
const {
  applySystemIncomePolLiveOverlay,
  buildSystemIncomePolAprWindows,
  buildSystemIncomePolReadModel
} = await import('../src/shared/system-income-pol.js');
const {
  compactSystemIncomePolEvents,
  refreshSystemIncomePolFeeEstimates
} = await import('../src/shared/system-income-pol-store.js');
const { runSystemIncomePolScheduler } = await import('../src/jobs/system-income-pol.js');
const { handleSystemIncomePol } = await import('../src/handlers/system-income-pol.js');

function event(type, attributes) {
  return {
    type,
    attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: String(value) }))
  };
}

test('SIPOL parser extracts exact rewards and pairs deployments with internal LP unit events', () => {
  const parsed = parseSystemIncomePolEvents([
    event('rewards', {
      bond_reward: 9,
      dev_fund_reward: 4,
      income_burn: 3,
      tcy_stake_reward: 2,
      marketing_fund_reward: 1,
      pol_reserve_reward: '9007199254740993',
      'TRON.USDT-XYZ': 8
    }),
    event('add_liquidity', {
      pool: 'BTC.BTC',
      liquidity_provider_units: '456',
      rune_address: 'thor1polmodule',
      rune_amount: '123',
      asset_amount: '0',
      THOR_txid: '0000000000000000000000000000000000000000000000000000000000000000'
    }),
    event('pol_reserve_deploy', { pool: 'BTC.BTC', rune_amount: '123' })
  ]);

  assert.deepEqual(parsed, {
    observed: true,
    rewardE8: '9007199254740993',
    systemIncomeE8: '9007199254741020',
    deployments: [{
      asset: 'BTC.BTC',
      runeE8: '123',
      unitsE8: '456',
      runeAddress: 'thor1polmodule'
    }],
    poolFees: []
  });
});

test('SIPOL parser supports encoded RPC attributes and leaves unmatched units explicit', () => {
  const encoded = (value) => Buffer.from(value).toString('base64');
  const payload = {
    result: {
      height: '321',
      finalize_block_events: [{
        type: encoded('rewards'),
        attributes: [{ key: encoded('pol_reserve_reward'), value: encoded('7') }]
      }, {
        type: encoded('pol_reserve_deploy'),
        attributes: [
          { key: encoded('pool'), value: encoded('ETH.ETH') },
          { key: encoded('rune_amount'), value: encoded('5') }
        ]
      }]
    }
  };
  assert.deepEqual(parseSystemIncomePolRpcBlock(payload), {
    observed: true,
    rewardE8: '7',
    systemIncomeE8: '7',
    deployments: [{ asset: 'ETH.ETH', runeE8: '5', unitsE8: null, runeAddress: '' }],
    poolFees: []
  });
});

test('SIPOL parser captures pool fees from tx and finalize events without double counting', () => {
  const swap = event('swap', {
    pool: 'BTC.BTC',
    id: 'ABC',
    liquidity_fee_in_rune: '11',
    emit_asset: 'BTC.BTC'
  });
  const parsed = parseSystemIncomePolEvents([], { feeEventGroups: [
    [swap],
    [swap, event('swap', {
      pool: 'ETH.ETH', id: 'DEF', liquidity_fee_in_rune: '7', emit_asset: 'ETH.ETH'
    })]
  ] });
  assert.deepEqual(parsed.poolFees, [
    { asset: 'BTC.BTC', feeE8: '11' },
    { asset: 'ETH.ETH', feeE8: '7' }
  ]);
});

test('SIPOL parser retains repeated identical fee events within one result lane', () => {
  const swap = event('swap', {
    pool: 'BTC.BTC', liquidity_fee_in_rune: '11', emit_asset: 'BTC.BTC'
  });
  const parsed = parseSystemIncomePolEvents([], { feeEventGroups: [[swap], [swap, swap]] });
  assert.deepEqual(parsed.poolFees, [{ asset: 'BTC.BTC', feeE8: '22' }]);
});

test('SIPOL parser matches the activation-block internal deployment fixture', () => {
  const pool = 'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T';
  const parsed = parseSystemIncomePolEvents([
    event('rewards', { pol_reserve_reward: '23211383', mode: 'EndBlock' }),
    event('add_liquidity', {
      pool,
      liquidity_provider_units: '8037053',
      rune_address: 'thor1fns25sytpf2gsdlg76g45620u5axm4mkrypqrh',
      rune_amount: '23211383',
      asset_amount: '0',
      asset_address: '',
      THOR_txid: '0000000000000000000000000000000000000000000000000000000000000000',
      mode: 'EndBlock'
    }),
    event('pol_reserve_deploy', { pool, rune_amount: '23211383', mode: 'EndBlock' })
  ]);
  assert.equal(parsed.rewardE8, '23211383');
  assert.deepEqual(parsed.deployments, [{
    asset: pool,
    runeE8: '23211383',
    unitsE8: '8037053',
    runeAddress: 'thor1fns25sytpf2gsdlg76g45620u5axm4mkrypqrh'
  }]);
});

test('SIPOL position builder values both pool sides without floating-point base-unit loss', () => {
  const rows = buildSystemIncomePolPositionRows({
    height: 999,
    observedAt: '2026-08-31T12:00:00Z',
    module: {
      address: 'thor1polmodule',
      coins: [{ denom: 'rune', amount: '700' }]
    },
    pools: [{
      asset: 'BTC.BTC',
      status: 'Available',
      balance_rune: '100000',
      balance_asset: '20000',
      pool_units: '10000',
      pol_reserve_rune_deposited: '5000',
      rolling_pool_liquidity_fee_rune: '44'
    }],
    liquidityProviders: new Map([['BTC.BTC', {
      units: '250',
      rune_redeem_value: '2500',
      asset_redeem_value: '500'
    }]])
  });

  assert.equal(rows.moduleAddress, 'thor1polmodule');
  assert.equal(rows.undeployedRuneE8, '700');
  assert.deepEqual(rows.positions[0], {
    asset: 'BTC.BTC',
    module_address: 'thor1polmodule',
    units_e8: '250',
    pool_units_e8: '10000',
    rune_deposited_e8: '5000',
    rune_held_e8: '2500',
    asset_held_e8: '500',
    asset_value_rune_e8: '2500',
    position_value_rune_e8: '5000',
    balance_rune_e8: '100000',
    balance_asset_e8: '20000',
    asset_tor_price_e8: '0',
    rolling_liquidity_fee_rune_e8: '44',
    status: 'Available',
    observed_height: 999,
    observed_at: '2026-08-31T12:00:00.000Z'
  });
});

test('SIPOL reconciliation reuses thornode-core pools and makes only narrow module/LP calls', async () => {
  const calls = [];
  const saved = [];
  const result = await reconcileSystemIncomePolState({ id: 'db' }, {
    now: new Date('2026-08-31T12:00:00Z'),
    getCoreSnapshot: async () => ({ payload: {
      lastblock: [{ chain: 'THOR', thorchain: '1000' }],
      network: { rune_price_in_tor: '200000000' },
      mimir: { POLRESERVESYSTEMINCOMEBPS: 2000 },
      pools: [{
        asset: 'BTC.BTC', status: 'Available', balance_rune: '1000', balance_asset: '100',
        pool_units: '100', pol_reserve_rune_deposited: '25'
      }]
    } }),
    fetchThorchain: async (path, requestOptions) => {
      calls.push({ path, requestOptions });
      if (path === '/thorchain/balance/module/pol_reserve') {
        return { address: 'thor1pol', coins: [{ denom: 'rune', amount: '4' }] };
      }
      return { units: '2', rune_redeem_value: '20', asset_redeem_value: '2' };
    },
    savePositions: async (_client, rows, meta) => saved.push({ rows, meta })
  });

  assert.deepEqual(calls.map((call) => call.path), [
    '/thorchain/balance/module/pol_reserve',
    '/thorchain/pool/BTC.BTC/liquidity_provider/thor1pol'
  ]);
  assert.deepEqual(
    calls.map((call) => call.requestOptions.cooldownScope),
    ['system-income-pol-reconciliation', 'system-income-pol-reconciliation']
  );
  assert.equal(saved.length, 1);
  assert.equal(result.positions, 1);
  assert.equal(result.undeployed_rune_e8, '4');
  assert.equal(result.rune_price_usd_e8, '200000000');
  assert.equal(result.pol_reserve_system_income_bps, 2000);
  assert.equal(saved[0].meta.runePriceUsdE8, '200000000');
  assert.equal(saved[0].meta.polReserveSystemIncomeBps, '2000');
});

test('SIPOL APR annualizes complete capital-weighted hours and reports seeded coverage', () => {
  const rows = [{
    asset: 'BTC.BTC', hour: '2026-09-02T11:00:00Z', estimated_fees_e8: '1',
    position_value_rune_e8: '10000', fee_coverage: 'complete',
    position_value_seeded: false, provisional: false
  }, {
    asset: 'ETH.ETH', hour: '2026-09-02T11:00:00Z', estimated_fees_e8: '1',
    position_value_rune_e8: '10000', fee_coverage: 'complete',
    position_value_seeded: false, provisional: false
  }, {
    asset: 'BTC.BTC', hour: '2026-09-02T10:00:00Z', estimated_fees_e8: '2',
    position_value_rune_e8: '10000', fee_coverage: 'complete',
    position_value_seeded: true, provisional: false
  }, {
    asset: 'ETH.ETH', hour: '2026-09-02T10:00:00Z', estimated_fees_e8: '2',
    position_value_rune_e8: '10000', fee_coverage: 'complete',
    position_value_seeded: true, provisional: false
  }, {
    asset: 'BTC.BTC', hour: '2026-09-02T09:00:00Z', estimated_fees_e8: null,
    position_value_rune_e8: '10000', fee_coverage: 'unavailable',
    position_value_seeded: false, provisional: false
  }, {
    asset: 'ETH.ETH', hour: '2026-09-02T09:00:00Z', estimated_fees_e8: '1',
    position_value_rune_e8: '10000', fee_coverage: 'complete',
    position_value_seeded: false, provisional: false
  }, {
    asset: 'BTC.BTC', hour: '2026-09-02T12:00:00Z', estimated_fees_e8: '100',
    position_value_rune_e8: '1', fee_coverage: 'partial',
    position_value_seeded: false, provisional: true
  }];

  const windows = buildSystemIncomePolAprWindows(rows, new Date('2026-09-02T12:05:00Z'));

  assert.deepEqual(windows['24h'], {
    estimated_fee_apr_bps: 13140,
    fees_e8: '6',
    position_value_hours_e8: '40000',
    target_hours: 24,
    available_hours: 3,
    covered_hours: 2,
    measured_hours: 1,
    seeded_hours: 1,
    status: 'warming',
    complete: false
  });
  assert.equal(windows['7d'].estimated_fee_apr_bps, 13140);
  assert.equal(windows['30d'].status, 'warming');
});

test('SIPOL APR becomes complete after 24 measured completed hours', () => {
  const rows = Array.from({ length: 24 }, (_, index) => ({
    asset: 'BTC.BTC',
    hour: new Date(Date.UTC(2026, 8, 2, 11 - index)).toISOString(),
    estimated_fees_e8: '1',
    position_value_rune_e8: '10000',
    fee_coverage: 'complete',
    position_value_seeded: false,
    provisional: false
  }));

  const windows = buildSystemIncomePolAprWindows(rows, new Date('2026-09-02T12:05:00Z'));

  assert.equal(windows['24h'].estimated_fee_apr_bps, 8760);
  assert.equal(windows['24h'].covered_hours, 24);
  assert.equal(windows['24h'].status, 'complete');
  assert.equal(windows['24h'].complete, true);
  assert.equal(windows['7d'].status, 'warming');
});

test('SIPOL read model combines exact daily flows, reconciled positions, and hourly block-fee shares', async () => {
  const model = await buildSystemIncomePolReadModel({ id: 'db' }, {
    now: new Date('2026-08-31T12:05:00Z'),
    loadDaily: async () => [{
      day: '2026-08-31', funded_e8: '100', system_income_e8: '1000', deployed_e8: '60', minted_units_e8: '5',
      first_height: '10', last_height: '20', partial: true
    }],
    loadPoolDaily: async () => [{
      asset: 'BTC.BTC', day: '2026-08-31', deployed_e8: '60', minted_units_e8: '5',
      partial: true
    }],
    loadPoolHourly: async () => [{
      asset: 'BTC.BTC', hour: '2026-08-31T11:00:00Z', pool_fees_e8: '60',
      estimated_fees_e8: '3', position_value_rune_e8: '60',
      position_value_seeded: false, fee_coverage: 'complete', provisional: false
    }],
    loadPositions: async () => [{
      asset: 'BTC.BTC', units_e8: '5', pool_units_e8: '100', rune_deposited_e8: '55',
      rune_held_e8: '30', asset_held_e8: '2', asset_value_rune_e8: '30',
      position_value_rune_e8: '60', rolling_liquidity_fee_rune_e8: '8', status: 'Available',
      observed_height: '20', observed_at: '2026-08-31T12:04:00Z'
    }],
    loadState: async () => ({
      module_address: 'thor1pol', undeployed_rune_e8: '40', rune_price_usd_e8: '200000000', last_event_height: '20',
      events_updated_at: '2026-08-31T12:04:30Z', positions_updated_at: '2026-08-31T12:04:00Z',
      fees_updated_at: '2026-08-31T12:03:00Z', last_error: '',
      stats_json: { pol_reserve_system_income_bps: 2000 }
    })
  });

  assert.deepEqual(model.payload.summary, {
    total_funded_e8: '100',
    total_system_income_e8: '1000',
    system_income_pol_share_bps: 1000,
    pol_reserve_system_income_bps: 2000,
    total_deployed_e8: '60',
    undeployed_rune_e8: '40',
    rune_price_usd_e8: '200000000',
    total_position_value_rune_e8: '60',
    total_position_value_usd_e8: '120',
    total_rune_held_e8: '30',
    total_rune_held_usd_e8: '60',
    rune_held_system_income_share_bps: 300,
    total_asset_value_rune_e8: '30',
    total_asset_value_usd_e8: '60',
    total_estimated_fees_e8: '3',
    total_estimated_fees_usd_e8: '6',
    fee_estimate_complete: true,
    fee_hours_covered: 1,
    fee_hours_total: 1,
    fee_hours_seeded: 0,
    fee_hours_provisional: 0,
    estimated_fee_apr: {
      '24h': {
        estimated_fee_apr_bps: 4380000,
        fees_e8: '3',
        position_value_hours_e8: '60',
        target_hours: 24,
        available_hours: 1,
        covered_hours: 1,
        measured_hours: 1,
        seeded_hours: 0,
        status: 'warming',
        complete: false
      },
      '7d': {
        estimated_fee_apr_bps: 4380000,
        fees_e8: '3',
        position_value_hours_e8: '60',
        target_hours: 168,
        available_hours: 1,
        covered_hours: 1,
        measured_hours: 1,
        seeded_hours: 0,
        status: 'warming',
        complete: false
      },
      '30d': {
        estimated_fee_apr_bps: 4380000,
        fees_e8: '3',
        position_value_hours_e8: '60',
        target_hours: 720,
        available_hours: 1,
        covered_hours: 1,
        measured_hours: 1,
        seeded_hours: 0,
        status: 'warming',
        complete: false
      }
    },
    active_pool_count: 1
  });
  assert.equal(model.payload.pools[0].share_bps, 500);
  assert.equal(model.payload.pools[0].rune_deposited_e8, '60');
  assert.equal(model.payload.pools[0].fee_hours_covered, 1);
  assert.equal(model.payload.coverage.fee_hours_total, 1);
  assert.equal(model.payload.daily[0].cumulative_funded_e8, '100');
  assert.equal(model.payload.freshness.positions_as_of, '2026-08-31T12:04:00.000Z');
});

test('SIPOL read model exposes seeded hourly estimates and marks provisional coverage', async () => {
  const model = await buildSystemIncomePolReadModel({ id: 'db' }, {
    now: new Date('2026-09-01T12:05:00Z'),
    loadDaily: async () => [{
      day: '2026-08-31', funded_e8: '100', deployed_e8: '60', minted_units_e8: '5',
      first_height: '10', last_height: '20', observed_blocks: 11, expected_blocks: 11
    }],
    loadPoolDaily: async () => [{
      asset: 'BTC.BTC', day: '2026-08-31', deployed_e8: '60'
    }, {
      asset: 'ETH.ETH', day: '2026-08-31', deployed_e8: '20'
    }],
    loadPoolHourly: async () => [{
      asset: 'BTC.BTC', hour: '2026-08-31T12:00:00Z', estimated_fees_e8: '3',
      fee_coverage: 'seeded', provisional: false
    }, {
      asset: 'ETH.ETH', hour: '2026-08-31T12:00:00Z', estimated_fees_e8: null,
      fee_coverage: 'unavailable', provisional: false
    }, {
      asset: 'BTC.BTC', hour: '2026-09-01T12:00:00Z', estimated_fees_e8: '1',
      fee_coverage: 'partial', provisional: true
    }],
    loadPositions: async () => [{
      asset: 'BTC.BTC', units_e8: '5', pool_units_e8: '100', rune_deposited_e8: '60',
      rune_held_e8: '30', asset_held_e8: '2', asset_value_rune_e8: '30',
      position_value_rune_e8: '60', observed_height: '20', observed_at: '2026-09-01T12:04:00Z'
    }, {
      asset: 'ETH.ETH', units_e8: '2', pool_units_e8: '100', rune_deposited_e8: '20',
      rune_held_e8: '10', asset_held_e8: '1', asset_value_rune_e8: '10',
      position_value_rune_e8: '20', observed_height: '20', observed_at: '2026-09-01T12:04:00Z'
    }],
    loadState: async () => ({
      activation_height: '10', last_event_height: '20',
      events_updated_at: '2026-08-31T12:04:30Z',
      positions_updated_at: '2026-09-01T12:04:00Z', fees_updated_at: '2026-09-01T12:03:00Z'
    })
  });

  assert.equal(model.payload.summary.total_estimated_fees_e8, '4');
  assert.equal(model.payload.summary.fee_estimate_complete, false);
  assert.equal(model.payload.daily[0].estimated_fees_e8, null);
  assert.equal(model.payload.pools.find((row) => row.asset === 'ETH.ETH').estimated_fees_e8, null);
  assert.equal(model.payload.coverage.fee_hours_seeded, 1);
  assert.equal(model.payload.coverage.fee_hours_provisional, 1);
  assert.match(model.payload.warnings.join(' '), /hours without an ownership seed/);
});

test('SIPOL compaction pins one exact durable watermark for every aggregate', async () => {
  const queries = [];
  const client = {
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/select height::text, block_time/i.test(sql)) {
        return { rows: [{ height: '27636630', block_time: '2026-08-31T12:00:00Z' }] };
      }
      if (/returning day/i.test(sql)) return { rowCount: 1, rows: [{ day: '2026-08-31' }] };
      if (/returning asset, day/i.test(sql)) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    }
  };
  const result = await compactSystemIncomePolEvents(client, { activationHeight: 27_636_623 });
  assert.equal(result.throughHeight, 27_636_630);
  assert.deepEqual(queries[1].params, [27_636_623, 27_636_630]);
  assert.deepEqual(queries[2].params, [27_636_623, 27_636_630]);
  assert.match(queries[1].sql, /height <= \$2/);
  assert.match(queries[2].sql, /blocks\.height <= \$2/);
});

test('SIPOL live overlay advances funded/deployed totals and preserves precise pool deltas', () => {
  const payload = applySystemIncomePolLiveOverlay({
    as_of: '2026-08-31T12:00:00Z',
    summary: {
      total_funded_e8: '100', total_deployed_e8: '60', undeployed_rune_e8: '40',
      total_system_income_e8: '1000', total_rune_held_e8: '30', total_estimated_fees_e8: '0'
    },
    pools: [{ asset: 'BTC.BTC', units_e8: '10', rune_deposited_e8: '60' }],
    daily: [{ day: '2026-08-31', funded_e8: '100', deployed_e8: '60',
      cumulative_funded_e8: '100', cumulative_deployed_e8: '60' }]
  }, {
    reward_e8: '9',
    system_income_e8: '90',
    deployments: [{ asset: 'BTC.BTC', rune_e8: '7', units_e8: '2' }],
    through_height: 22,
    through_time: '2026-08-31T12:00:06Z'
  });
  assert.equal(payload.summary.total_funded_e8, '109');
  assert.equal(payload.summary.total_deployed_e8, '67');
  assert.equal(payload.summary.total_system_income_e8, '1090');
  assert.equal(payload.summary.undeployed_rune_e8, '40');
  assert.equal(payload.pools[0].rune_deposited_e8, '67');
  assert.equal(payload.pools[0].units_e8, '10');
  assert.equal(payload.live.through_height, 22);
  assert.equal(payload.freshness.events_as_of, '2026-08-31T12:00:06.000Z');
});

test('SIPOL live overlay starts a new UTC day without waiting for reconciliation', () => {
  const payload = applySystemIncomePolLiveOverlay({
    summary: {
      total_funded_e8: '100', total_system_income_e8: '1000', total_deployed_e8: '60', undeployed_rune_e8: '40'
    },
    pools: [],
    daily: [{
      day: '2026-08-31', funded_e8: '100', deployed_e8: '60',
      cumulative_funded_e8: '100', cumulative_deployed_e8: '60'
    }]
  }, {
    reward_e8: '9', system_income_e8: '90', deployments: [], through_height: 22,
    through_time: '2026-09-01T00:00:06Z'
  });

  assert.deepEqual(payload.daily.at(-1), {
    day: '2026-09-01',
    funded_e8: '9',
    system_income_e8: '90',
    deployed_e8: '0',
    minted_units_e8: null,
    estimated_fees_e8: null,
    cumulative_funded_e8: '109',
    cumulative_system_income_e8: '1090',
    cumulative_deployed_e8: '60',
    first_height: null,
    last_height: 22,
    partial: true,
    fee_coverage: null
  });
});

test('SIPOL hourly fee refresh seeds from durable block fees and preserves source freshness', async () => {
  const queries = [];
  const client = {
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/with bounds as/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ source_updated_at: '2026-08-31T12:00:00Z' }]
        };
      }
      return { rowCount: 1, rows: [] };
    }
  };

  const result = await refreshSystemIncomePolFeeEstimates(client, {
    activationHeight: 27_636_623,
    now: '2026-08-31T12:05:00Z'
  });

  assert.match(queries[0].sql, /date_trunc\('hour'/);
  assert.match(queries[0].sql, /jsonb_array_elements\(coalesce\(blocks\.pool_fees/);
  assert.match(queries[0].sql, /system_income_pol_pool_hourly/);
  assert.match(queries[0].sql, /position_value_rune_e8/);
  assert.match(queries[0].sql, /position_value_seeded/);
  assert.match(queries[0].sql, /'seeded'/);
  assert.doesNotMatch(queries[0].sql, /pool_analysis_daily/);
  assert.equal(queries[1].params[8], '2026-08-31T12:00:00.000Z');
  assert.equal(result.sourceUpdatedAt, '2026-08-31T12:00:00.000Z');
});

test('SIPOL scheduler uses an isolated lock and publishes provider-free model', async () => {
  const calls = [];
  await runSystemIncomePolScheduler({
    lockRunner: async (key, callback) => {
      calls.push(['lock', key]);
      return callback({ id: 'db' });
    },
    repair: async () => ({ repaired: 2 }),
    compact: async () => ({ days: 1 }),
    reconcile: async () => ({ positions: 1 }),
    refreshFees: async () => ({ rows: 1 }),
    publish: async (options) => {
      calls.push(['publish', options.modelKey]);
      await options.build();
      return { ok: true };
    },
    buildReadModel: async () => ({ payload: {} })
  });
  assert.deepEqual(calls, [
    ['lock', 'boonetools:system-income-pol'],
    ['publish', 'system-income-pol:v1']
  ]);
});

test('SIPOL scheduler exhausts bounded repair batches before publishing', async () => {
  let repairCalls = 0;
  const calls = [];
  const result = await runSystemIncomePolScheduler({
    repairMaxBatches: 3,
    lockRunner: async (_key, callback) => callback({ id: 'db' }),
    repair: async () => {
      repairCalls += 1;
      return {
        repaired: 1,
        headHeight: 27_636_625,
        complete: repairCalls === 3
      };
    },
    compact: async () => {
      calls.push('compact');
      return { days: 1 };
    },
    reconcile: async () => ({ positions: 1 }),
    refreshFees: async () => ({ rows: 0 }),
    publish: async () => ({ ok: true })
  });
  assert.equal(repairCalls, 3);
  assert.equal(result.repair.repaired, 3);
  assert.deepEqual(calls, ['compact']);
});

test('SIPOL scheduler refuses to publish an incomplete activation backfill', async () => {
  const calls = [];
  await assert.rejects(runSystemIncomePolScheduler({
    repairMaxBatches: 2,
    lockRunner: async (_key, callback) => callback({ id: 'db' }),
    repair: async () => ({ repaired: 30_000, headHeight: 27_700_000, complete: false }),
    compact: async () => calls.push('compact'),
    reconcile: async () => calls.push('reconcile'),
    refreshFees: async () => calls.push('fees'),
    publish: async () => calls.push('publish'),
    updateState: async () => calls.push('error-state')
  }), /activation backfill is incomplete through 27700000/);
  assert.deepEqual(calls, ['error-state']);
});

test('SIPOL handler serves only the durable model plus chain-header overlay', async () => {
  const response = await handleSystemIncomePol({ headers: {} }, new URL('http://local/pol-tracker'), {
    getReadModel: async () => ({
      key: 'system-income-pol:v1', schemaVersion: 1, generatedAt: '2026-08-31T12:00:00Z',
      publishedAt: '2026-08-31T12:00:01Z', freshUntil: '2026-08-31T12:05:00Z',
      ageSeconds: 3, stale: false, etag: 'base',
      payload: {
        as_of: '2026-08-31T12:00:00Z',
        summary: { total_funded_e8: '10', total_deployed_e8: '5', undeployed_rune_e8: '5' },
        pools: [], daily: [], live: { through_height: 10, through_time: '2026-08-31T12:00:00Z' }
      }
    }),
    getLiveOverlay: async (afterHeight) => {
      assert.equal(afterHeight, 10);
      return { reward_e8: '2', deployments: [], through_height: 12, through_time: '2026-08-31T12:00:06Z' };
    }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.body.summary.total_funded_e8, '12');
  assert.equal(response.body.read_model.key, 'system-income-pol:v1');
});

test('SIPOL production contract keeps legacy POL at pol-tvl and serves SIPOL from pol-tracker', async () => {
  const [migration, headlineMigration, hourlyMigration, aprMigration, server, runJob, repair, service, timer, deploy, smoke] = await Promise.all([
    readFile(new URL('../migrations/054_system_income_pol.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/055_system_income_pol_headlines.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/057_system_income_pol_hourly_fees.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/058_system_income_pol_fee_apr.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/run-job.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/shared/system-income-pol-repair.js', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-system-income-pol.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-system-income-pol.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/deploy-boonetools-backend-remote.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/perf-smoke.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(migration, /system_income_pol_observed/);
  assert.match(migration, /create table if not exists public\.system_income_pol_blocks/);
  assert.match(migration, /create table if not exists public\.system_income_pol_positions/);
  assert.match(headlineMigration, /system_income_total_e8/);
  assert.match(headlineMigration, /rune_price_usd_e8/);
  assert.match(hourlyMigration, /create table if not exists public\.system_income_pol_pool_hourly/);
  assert.match(hourlyMigration, /provisional boolean not null/);
  assert.match(aprMigration, /position_value_rune_e8/);
  assert.match(aprMigration, /position_value_seeded/);
  assert.match(aprMigration, /update public\.system_income_pol_position_samples/);
  assert.match(server, /\['\/pol-tracker', route\(handleSystemIncomePol, 1, 64\)\]/);
  assert.match(server, /\['\/pol-tvl', route\(handlePolTracker, 1, 64\)\]/);
  assert.match(runJob, /'system-income-pol-scheduler': runSystemIncomePolScheduler/);
  assert.match(repair, /cooldownScope: 'system-income-pol-repair'/);
  assert.match(repair, /blocks\.system_income_e8 is null/);
  assert.match(service, /src\/run-job\.js system-income-pol-scheduler/);
  assert.match(timer, /OnUnitActiveSec=2min/);
  assert.match(deploy, /boonetools-system-income-pol\.service/);
  assert.doesNotMatch(deploy.match(/OPTIONAL_PRIME_UNIT_PATTERN=.*/)?.[0] || '', /system-income-pol/);
  assert.doesNotMatch(deploy, /--allow-stale-endpoint pol-tracker/);
  assert.match(deploy, /--allow-stale-endpoint pol-tvl/);
  assert.match(smoke, /name: 'pol-tvl', path: '\/pol-tvl'/);
});
