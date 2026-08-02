import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ensureThorchainMarketSnapshot,
  thorchainMarketSnapshotRpcUrls
} from '../src/shared/thorchain-market-snapshots.js';

function memoryClient() {
  let stored = null;
  return {
    async query(sql, params) {
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
      result: { block: { header: { time: '2026-08-02T12:00:00Z' } } }
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

test('canonical historical block time uses the isolated Liquify archive RPC lane', () => {
  const urls = thorchainMarketSnapshotRpcUrls();
  assert.match(urls[0], /rpc\.thorchain\.liquify\.com/);
  assert.ok(urls.some((url) => url.includes('/chain/thorchain_rpc')));
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
