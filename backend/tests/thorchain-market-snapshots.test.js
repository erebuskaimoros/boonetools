import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ensureThorchainMarketSnapshot,
  thorchainMarketSnapshotRpcUrls
} from '../src/shared/thorchain-market-snapshots.js';

function memoryClient(headerTime = null) {
  let stored = null;
  const acquisitions = new Map();
  return {
    async query(sql, params) {
      if (sql.includes('from chain_block_headers')) return { rows: headerTime ? [{ height: params[0], block_time: headerTime }] : [] };
      if (sql.includes('from source_observations')) return { rows: acquisitions.has(params[1]) ? [acquisitions.get(params[1])] : [] };
      if (sql.includes('insert into source_observations')) {
        const row = { payload_json: JSON.parse(params[2]), source: params[3], observed_at: params[4], expires_at: params[5], completed_at: params[6] };
        acquisitions.set(params[1], row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('pg_advisory_')) return { rows: [] };
      if (sql.includes('from thorchain_market_snapshots')) {
        return { rows: stored ? [stored] : [] };
      }
      if (sql.includes('insert into thorchain_market_snapshots')) {
        stored = {
          height: params[0],
          block_time: params[1],
          pools_json: JSON.parse(params[2]),
          oracle_prices_json: JSON.parse(params[3]),
          source: params[4]
        };
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

test('canonical market acquisition reuses one same-height pool/oracle snapshot', async () => {
  const client = memoryClient();
  const calls = [];
  const options = {
    fetchThorchain: async (path) => {
      calls.push(path);
      return path.includes('/pools')
        ? [{ asset: 'BTC.BTC', status: 'Available' }]
        : { prices: [{ symbol: 'RUNE', price: '1.2' }, { symbol: 'BTC', price: '100000' }] };
    },
    fetchBlock: async () => ({
      result: { block: { header: { height: '27200000', time: '2026-08-02T12:00:00Z' } } }
    })
  };
  const first = await ensureThorchainMarketSnapshot(client, 27200000, options);
  const second = await ensureThorchainMarketSnapshot(client, 27200000, {
    fetchThorchain: async () => { throw new Error('cache was not reused'); },
    fetchBlock: async () => { throw new Error('cache was not reused'); }
  });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.height, 27200000);
  assert.equal(second.pools[0].asset, 'BTC.BTC');
  assert.deepEqual(calls, [
    '/thorchain/pools?height=27200000',
    '/thorchain/oracle/prices?height=27200000'
  ]);
});

test('market acquisition reuses an exact stored header time while fetching same-height prices', async () => {
  const client = memoryClient('2026-08-02T12:00:00Z');
  const calls = [];
  let blockCalls = 0;
  const result = await ensureThorchainMarketSnapshot(client, 27200000, {
    fetchThorchain: async (endpoint) => {
      calls.push(endpoint);
      return endpoint.includes('/pools') ? [{ asset: 'BTC.BTC' }] : { prices: [{ symbol: 'RUNE', price: '1.2' }] };
    },
    fetchBlock: async () => {
      blockCalls++;
      return { result: { block: { header: { height: '27200000', time: '2026-08-02T12:00:00Z' } } } };
    }
  });
  assert.equal(blockCalls, 0);
  assert.equal(result.blockTime, '2026-08-02T12:00:00.000Z');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((endpoint) => endpoint.endsWith('height=27200000')));
});

test('canonical historical block time uses a dedicated live-RPC cooldown lane', () => {
  const urls = thorchainMarketSnapshotRpcUrls();
  assert.ok(urls[0].includes('/chain/thorchain_rpc'));
  assert.ok(urls.some((url) => /rpc\.thorchain\.liquify\.com/.test(url)));
});

test('Wasm production lanes are independently registered, timed, and primed', async () => {
  const [migration, registry, activity, fees, oracle, deploy] = await Promise.all([
    readFile(new URL('../migrations/038_provider_lanes_and_market_snapshots.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/run-job.js', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-wasm-arb-economics.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-wasm-arb-economics-fees.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-wasm-arb-economics-oracle.service', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/deploy-boonetools-backend-remote.sh', import.meta.url), 'utf8')
  ]);
  assert.match(migration, /create table if not exists public\.thorchain_market_snapshots/i);
  assert.match(registry, /'wasm-arb-economics-scheduler': runWasmArbEconomicsScheduler/);
  assert.match(registry, /'wasm-arb-economics-fees': runWasmArbEconomicsFees/);
  assert.match(registry, /'wasm-arb-economics-oracle': runWasmArbEconomicsOracle/);
  assert.match(activity, /wasm-arb-economics-scheduler/);
  assert.match(fees, /wasm-arb-economics-fees/);
  assert.match(fees, /TimeoutStartSec=10min/);
  assert.match(oracle, /wasm-arb-economics-oracle/);
  assert.match(deploy, /boonetools-wasm-arb-economics\.service[\s\S]*boonetools-wasm-arb-economics-fees\.service[\s\S]*boonetools-wasm-arb-economics-oracle\.service/);
});
