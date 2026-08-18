import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';

const {
  buildRujiraBaseLayerEarningsPayload,
  buildWeightedRoutableBalances,
  calculateRujiraBaseLayerEarningsDay,
  deriveRujiraBaseLayerRouteScopes,
  reconcileCompletedRujiraBaseLayerEarnings,
  serializeRujiraBaseLayerEarningsJson
} = await import('../src/shared/rujira-base-layer-earnings.js');

const BASE_COLLECTOR = 'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr';

function routePayload() {
  return {
    configs: {
      trade: {
        target_addresses: [['thor1stakers', '50'], [BASE_COLLECTOR, '50']],
        target_denoms: [['rune'], ['eth-usdc-token']]
      },
      core: {
        target_addresses: [[BASE_COLLECTOR, '1'], ['thor1stakers', '1']],
        target_denoms: [['rune']]
      },
      base: {
        target_addresses: [['thor1reserve', '1']],
        target_denoms: [['rune']]
      }
    },
    actions: {
      trade: [],
      core: [],
      base: [{ denom: 'eth-usdc-token' }]
    }
  };
}

function balances({ tradeRune = 0, coreRune = 0, baseRune = 0, baseUsdc = 0 } = {}) {
  return {
    trade: { rune: tradeRune },
    core: { rune: coreRune },
    base: { rune: baseRune, 'eth-usdc-token': baseUsdc }
  };
}

test('route scopes follow the configured Base Layer share and routable denoms', () => {
  const scopes = deriveRujiraBaseLayerRouteScopes(routePayload());

  assert.deepEqual(
    scopes.map(({ key, baseLayerShare }) => ({ key, baseLayerShare })),
    [
      { key: 'trade', baseLayerShare: 0.5 },
      { key: 'core', baseLayerShare: 0.5 },
      { key: 'base', baseLayerShare: 1 }
    ]
  );
  assert.deepEqual(scopes.find((scope) => scope.key === 'base').routableDenoms, [
    'rune',
    'eth-usdc-token'
  ]);
});

test('JSON array parameters are serialized for Postgres jsonb columns', () => {
  const scopes = [{ key: 'trade', baseLayerShare: 0.5 }];
  const unpriced = ['thor.auto', 'x/brune'];

  assert.equal(
    serializeRujiraBaseLayerEarningsJson(scopes),
    '[{"key":"trade","baseLayerShare":0.5}]'
  );
  assert.equal(
    serializeRujiraBaseLayerEarningsJson(unpriced),
    '["thor.auto","x/brune"]'
  );
});

test('transfers between scoped collectors do not create Base Layer earnings', () => {
  const scopes = deriveRujiraBaseLayerRouteScopes(routePayload());
  const before = buildWeightedRoutableBalances(balances({ tradeRune: 100 }), scopes);
  const after = buildWeightedRoutableBalances(
    balances({ tradeRune: 80, baseRune: 10 }),
    scopes
  );

  assert.equal(before.rune, 50);
  assert.equal(after.rune, 50);

  const result = calculateRujiraBaseLayerEarningsDay({
    baselineBalances: balances({ tradeRune: 100 }),
    currentBalances: balances({ tradeRune: 80, baseRune: 10 }),
    routeScopes: scopes,
    prices: { 'THOR.RUNE': 2 }
  });
  assert.equal(result.inflowUsd, 0);
});

test('conversion inventory changes and Reserve payouts cancel while fresh fees remain', () => {
  const scopes = deriveRujiraBaseLayerRouteScopes(routePayload());
  const conversion = calculateRujiraBaseLayerEarningsDay({
    baselineBalances: balances({ baseUsdc: 100 }),
    currentBalances: balances({ baseRune: 50 }),
    routeScopes: scopes,
    prices: { 'THOR.RUNE': 2, 'ETH.USDC-TOKEN': 1 }
  });
  assert.equal(conversion.inflowUsd, 0);

  const payout = calculateRujiraBaseLayerEarningsDay({
    baselineBalances: balances({ baseRune: 100 }),
    currentBalances: balances({ baseRune: 50 }),
    routeScopes: scopes,
    prices: { 'THOR.RUNE': 2 },
    reservePayoutRune: 50,
    reservePayoutUsd: 100
  });
  assert.equal(payout.inflowUsd, 0);
  assert.deepEqual(payout.byDenom.rune, { amount: 0, usd: 0 });

  const freshFees = calculateRujiraBaseLayerEarningsDay({
    baselineBalances: balances(),
    currentBalances: balances({ tradeRune: 20 }),
    routeScopes: scopes,
    prices: { 'THOR.RUNE': 2 }
  });
  assert.equal(freshFees.inflowUsd, 20);
});

test('completed earnings days reconcile late Reserve/POL settlements and final daily pricing', async () => {
  const updates = [];
  const client = {
    query: async (sql, params = []) => {
      if (sql.includes('left join settlement_by_day')) {
        assert.deepEqual(params, ['2026-08-03']);
        return {
          rows: [
            {
              day_start: '2026-08-01',
              by_denom: {
                rune: { amount: 111.14919798, usd: 44.64732547 },
                'thor.auto': { amount: -34.22644417, usd: 0 }
              },
              inventory_delta_usd: -290.47172936,
              reserve_payout_rune: 792.09114,
              reserve_payout_usd: 342.17258198,
              current_reserve_payout_rune: 797.96198,
              current_reserve_payout_usd: 348.53964426
            },
            {
              day_start: '2026-08-02',
              by_denom: { rune: { amount: 20, usd: 8 } },
              inventory_delta_usd: -2,
              reserve_payout_rune: 10,
              reserve_payout_usd: 4,
              current_reserve_payout_rune: 10,
              current_reserve_payout_usd: 4
            }
          ]
        };
      }
      if (sql.includes('update rujira_base_layer_earnings_daily')) {
        updates.push(params);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const stats = await reconcileCompletedRujiraBaseLayerEarnings(client, '2026-08-03');

  assert.equal(stats.checked_days, 2);
  assert.equal(stats.reconciled_days, 1);
  assert.ok(Math.abs(stats.reserve_payout_rune_delta - 5.87084) < 1e-8);
  assert.ok(Math.abs(stats.reserve_payout_usd_delta - 6.36706228) < 1e-8);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0], '2026-08-01');
  assert.ok(Math.abs(updates[0][1].rune.amount - 117.02003798) < 1e-8);
  assert.ok(Math.abs(updates[0][1].rune.usd - 51.01438775) < 1e-8);
  assert.equal(updates[0][1]['thor.auto'].amount, -34.22644417);
  assert.equal(updates[0][2], 797.96198);
  assert.equal(updates[0][3], 348.53964426);
  assert.ok(Math.abs(updates[0][4] - 58.0679149) < 1e-8);
});

test('dashboard payload replaces static days with DB snapshots and rebuilds totals', () => {
  const seed = {
    meta: { baselineInventoryUsd: 100, generatedAt: '2026-07-13T00:00:00Z' },
    daily: [
      {
        day_start: '2026-07-13',
        day_end: '2026-07-14',
        transfers: 1,
        inflow_usd: 10,
        by_denom: { rune: { amount: 5, usd: 10 } }
      },
      {
        day_start: '2026-07-14',
        day_end: '2026-07-15',
        transfers: 1,
        inflow_usd: 20,
        by_denom: { rune: { amount: 10, usd: 20 } }
      }
    ]
  };
  const databaseRows = [
    {
      day_start: '2026-07-15',
      day_end: '2026-07-16',
      transfers: 1,
      inflow_usd: 30,
      by_denom: { rune: { amount: 15, usd: 30 } },
      snapshot_time: '2026-07-15T12:00:00Z'
    },
    {
      day_start: '2026-07-14',
      day_end: '2026-07-15',
      transfers: 1,
      inflow_usd: 25,
      by_denom: { rune: { amount: 12.5, usd: 25 } },
      snapshot_time: '2026-07-14T23:59:00Z'
    }
  ];

  const payload = buildRujiraBaseLayerEarningsPayload(
    seed,
    databaseRows,
    new Date('2026-07-15T12:02:00Z')
  );

  assert.deepEqual(payload.daily.map((row) => row.inflow_usd), [10, 25, 30]);
  assert.deepEqual(payload.daily.map((row) => row.cumulative_usd), [110, 135, 165]);
  assert.equal(payload.weekly[0].inflow_usd, 65);
  assert.equal(payload.weekly[0].cumulative_usd, 165);
  assert.deepEqual(payload.denomTotals[0], {
    denom: 'rune',
    amount: 32.5,
    usd: 65,
    priced: true
  });
  assert.equal(payload.meta.source, 'backend-chain-state');
  assert.equal(payload.meta.live, true);
  assert.equal(payload.meta.stale, false);
});
