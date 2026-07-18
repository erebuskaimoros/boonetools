import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TREASURY_LP_DISCOVERY_TTL_MS,
  buildTreasurySnapshot
} from '../src/treasury/builder.js';
import { fetchTreasuryCore } from '../src/treasury/providers.js';

const NOW = new Date('2026-07-18T12:00:00.000Z');

function corePayload(overrides = {}) {
  return {
    network: { ok: true, value: { rune_price_in_tor: '200000000' } },
    pools: {
      ok: true,
      value: [
        { asset: 'BTC.BTC', status: 'Available', asset_tor_price: '6000000000000' },
        { asset: 'ETH.ETH', status: 'Available', asset_tor_price: '300000000000' },
        { asset: 'BSC.BNB', status: 'Available', asset_tor_price: '60000000000' }
      ]
    },
    nodes: {
      ok: true,
      value: [{
        node_address: 'thor1node00000000000000000000000000000000abcd',
        status: 'Active',
        bond_providers: {
          providers: [{
            bond_address: 'thor10qh5272ktq4wes8ex343ky9rsuehcypddjh08k',
            bond: '100000000'
          }]
        }
      }]
    },
    module: {
      ok: true,
      value: {
        address: 'thor1module000000000000000000000000000000000',
        coins: [{ denom: 'rune', amount: '300000000' }]
      }
    },
    ...overrides
  };
}

function providers(overrides = {}) {
  return {
    fetchTreasuryCore: async () => corePayload(),
    fetchThorBalance: async (address) => address.startsWith('thor1module')
      ? [{ denom: 'rune', amount: '300000000' }]
      : [{ denom: 'rune', amount: '100000000' }],
    fetchExternalHoldings: async (entry) => [{
      asset: {
        ETH: 'ETH.ETH',
        BTC: 'BTC.BTC',
        SOL: 'SOL.SOL',
        TRON: 'TRON.TRX'
      }[entry.chain],
      chain: entry.chain,
      amount: 1
    }],
    fetchMemberPoolAssets: async (address) => address.includes('10qh') ? ['BTC.BTC'] : [],
    fetchLiquidityProvider: async (asset) => ({
      asset,
      units: '10',
      asset_redeem_value: '100000000',
      rune_redeem_value: '200000000'
    }),
    fetchTokenPrices: async () => ({}),
    mapWithConcurrency: async (items, _limit, worker) => Promise.all(items.map(worker)),
    ...overrides
  };
}

test('fetchTreasuryCore fetches shared network, pools, nodes, and module data exactly once', async () => {
  const calls = [];
  const result = await fetchTreasuryCore({
    fetchThorchain: async (path) => {
      calls.push(path);
      return path.endsWith('/network') ? {} : path.endsWith('/module/treasury') ? { address: 'thor1x', coins: [] } : [];
    }
  });

  assert.deepEqual(calls.sort(), [
    '/thorchain/balance/module/treasury',
    '/thorchain/network',
    '/thorchain/nodes',
    '/thorchain/pools'
  ]);
  assert.equal(Object.values(result).every((segment) => segment.ok), true);
});

test('Treasury snapshot builds the complete UI contract without request-time provider work', async () => {
  const snapshot = await buildTreasurySnapshot({ providers: providers(), now: () => NOW });

  assert.equal(snapshot.source, 'boonetools-backend');
  assert.equal(snapshot.runePrice, 2);
  assert.equal(snapshot.sections.length, 2);
  assert.equal(snapshot.sections.flatMap((section) => section.entries).length, 8);
  assert.equal(snapshot.sections[0].entries[0].address, 'thor1module000000000000000000000000000000000');
  assert.equal(snapshot.consolidatedSection.summary.addressCount, 8);
  assert.equal(snapshot.sections[1].entries.find((entry) => entry.label === 'Treasury Vultisig').bonds.length, 1);
  assert.equal(snapshot.sections[1].entries.find((entry) => entry.label === 'Treasury Vultisig').lpPositions.length, 1);
  assert.ok(snapshot.totalSummary.totalValue > 0);
  assert.equal(snapshot.control.lpDiscovery['active:Treasury Vultisig'].assets[0], 'BTC.BTC');
});

test('Treasury refresh reuses failed segments and skips LP rediscovery until its slower cadence is due', async () => {
  const first = await buildTreasurySnapshot({ providers: providers(), now: () => NOW });
  let discoveryCalls = 0;
  const failedProviders = providers({
    fetchTreasuryCore: async () => corePayload({
      network: { ok: false, error: 'network down' },
      pools: { ok: false, error: 'pools down' },
      nodes: { ok: false, error: 'nodes down' },
      module: { ok: false, error: 'module down' }
    }),
    fetchThorBalance: async () => { throw new Error('bank down'); },
    fetchExternalHoldings: async () => { throw new Error('chain down'); },
    fetchMemberPoolAssets: async () => {
      discoveryCalls += 1;
      throw new Error('should not be called');
    },
    fetchLiquidityProvider: async () => { throw new Error('LP down'); }
  });
  const second = await buildTreasurySnapshot({
    previousSnapshot: first,
    providers: failedProviders,
    now: () => new Date(NOW.getTime() + TREASURY_LP_DISCOVERY_TTL_MS - 1)
  });

  assert.equal(discoveryCalls, 0);
  assert.equal(second.runePrice, first.runePrice);
  assert.equal(second.totalSummary.totalValue, first.totalSummary.totalValue);
  assert.equal(second.source_updated_at, first.source_updated_at);
  assert.equal(
    second.segment_health.segments.network.observed_at,
    first.segment_health.segments.network.observed_at
  );
  assert.ok(second.segment_health.segments.network.age_seconds > 0);
  assert.ok(second.segment_health.reused > 0);
  assert.match(second.warnings.join('\n'), /reused last successful/);
  assert.equal(
    second.sections[1].entries.find((entry) => entry.label === 'Treasury Vultisig').lpPositions.length,
    1
  );
});

test('first-run broad LP fallback collapses to active pools and failed rediscovery backs off', async () => {
  let memberCalls = 0;
  let lpCalls = 0;
  const fallbackProviders = providers({
    fetchMemberPoolAssets: async () => {
      memberCalls += 1;
      throw new Error('Midgard unavailable');
    },
    fetchLiquidityProvider: async (asset, address) => {
      lpCalls += 1;
      if (asset === 'BTC.BTC' && address.includes('10qh')) {
        return {
          asset,
          units: '10',
          asset_redeem_value: '100000000',
          rune_redeem_value: '200000000'
        };
      }
      return null;
    }
  });

  const first = await buildTreasurySnapshot({ providers: fallbackProviders, now: () => NOW });
  assert.equal(memberCalls, 4);
  assert.equal(lpCalls, 12);
  assert.deepEqual(first.control.lpDiscovery['active:Treasury Vultisig'].assets, ['BTC.BTC']);
  assert.deepEqual(first.control.lpDiscovery['active:Treasury Test'].assets, []);
  assert.equal(
    first.segment_health.segments['lp:active:Treasury Vultisig:BTC.BTC'].status,
    'fresh'
  );

  const second = await buildTreasurySnapshot({
    previousSnapshot: first,
    providers: fallbackProviders,
    now: () => new Date(NOW.getTime() + 5 * 60 * 1000)
  });
  assert.equal(memberCalls, 4);
  assert.equal(lpCalls, 13);

  const due = await buildTreasurySnapshot({
    previousSnapshot: second,
    providers: fallbackProviders,
    now: () => new Date(NOW.getTime() + TREASURY_LP_DISCOVERY_TTL_MS + 1)
  });
  assert.equal(memberCalls, 8);
  assert.equal(lpCalls, 14);
  assert.ok(due.control.lpDiscovery['active:Treasury Vultisig'].nextAttemptAt);

  await buildTreasurySnapshot({
    previousSnapshot: due,
    providers: fallbackProviders,
    now: () => new Date(NOW.getTime() + TREASURY_LP_DISCOVERY_TTL_MS + 5 * 60 * 1000)
  });
  assert.equal(memberCalls, 8);
  assert.equal(lpCalls, 15);
});
