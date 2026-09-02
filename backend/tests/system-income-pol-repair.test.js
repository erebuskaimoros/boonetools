import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';

const { repairSystemIncomePolBlocks } = await import('../src/shared/system-income-pol-repair.js');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function blockResult(height) {
  return {
    result: {
      height: String(height),
      finalize_block_events: [{
        type: 'rewards',
        attributes: [
          { key: 'bond_reward', value: '10' },
          { key: 'pol_reserve_reward', value: '2' }
        ]
      }]
    }
  };
}

function repairStore(firstHeight, lastHeight) {
  const ledger = new Map();
  const candidates = Array.from({ length: lastHeight - firstHeight + 1 }, (_, index) => firstHeight + index);
  const headers = new Map(candidates.map((height, index) => {
    return [height, {
      height,
      block_hash: `BLOCK${height}`,
      block_time: new Date(Date.UTC(2026, 8, 2, 0, 0, index * 6)).toISOString(),
      has_swap_events: false,
      source: 'liquify-rpc-repair',
      system_income_pol_observed: false
    }];
  }));
  const missing = (start, end) => candidates
    .filter((height) => height >= start && height <= end && !ledger.has(height));
  return {
    ledger,
    headers,
    async query(sql, params = []) {
      if (sql.includes('select candidate.height::bigint')) {
        return { rows: missing(params[0], params[1]).slice(0, params[2]).map((height) => ({ height })) };
      }
      if (sql.includes('select exists') && sql.includes('system_income_pol_blocks')) {
        return { rows: [{ missing: missing(params[0], params[1]).length > 0 }] };
      }
      if (sql.includes('insert into system_income_pol_blocks')) {
        const rows = JSON.parse(params[0]);
        for (const row of rows) ledger.set(row.height, row);
        return { rows: [], rowCount: rows.length };
      }
      if (sql.includes('insert into chain_block_headers')) {
        for (let index = 0; index < params.length; index += 11) {
          const height = params[index];
          headers.set(height, {
            ...headers.get(height),
            height,
            block_hash: params[index + 1],
            block_time: params[index + 2],
            has_swap_events: params[index + 3],
            source: params[index + 4],
            system_income_total_e8: params[index + 6],
            system_income_pol_observed: params[index + 7],
            system_income_pol_reward_e8: params[index + 8],
            system_income_pol_deployments: JSON.parse(params[index + 9]),
            system_income_pol_pool_fees: JSON.parse(params[index + 10])
          });
        }
        return { rows: [], rowCount: params.length / 11 };
      }
      if (sql.includes('update chain_block_headers current')) return { rows: [], rowCount: 0 };
      if (sql.includes('from chain_block_headers')) {
        const heights = Array.isArray(params[0])
          ? params[0]
          : [...headers.keys()].filter((height) => height >= params[0] && height <= params[1]);
        return { rows: heights.map((height) => headers.get(height)).filter(Boolean) };
      }
      if (sql.includes('insert into system_income_pol_state')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected repair query: ${sql}`);
    }
  };
}

test('SIPOL repair retains successful blocks across a provider failure so retries fetch only missing heights', async () => {
  const store = repairStore(100, 102);
  const firstCalls = [];
  const options = { activationHeight: 100, headHeight: 102, limit: 3, concurrency: 1 };

  await assert.rejects(repairSystemIncomePolBlocks(store, {
    ...options,
    async fetchRpc(endpoint, { height }) {
      assert.equal(endpoint, '/block_results');
      firstCalls.push(height);
      if (height === 101) throw new Error('provider timeout at 101');
      return blockResult(height);
    }
  }), /provider timeout at 101/);

  assert.deepEqual(firstCalls, [100, 101]);
  assert.deepEqual([...store.ledger.keys()], [100], 'completed provider work must survive the failed repair run');
  assert.equal(store.headers.get(100).system_income_pol_observed, true);

  const retryCalls = [];
  const result = await repairSystemIncomePolBlocks(store, {
    ...options,
    async fetchRpc(endpoint, { height }) {
      assert.equal(endpoint, '/block_results');
      retryCalls.push(height);
      return blockResult(height);
    }
  });
  assert.deepEqual(retryCalls, [101, 102]);
  assert.equal(result.repaired, 2);
  assert.equal(result.complete, true);
});

test('SIPOL repair reuses the durable fresh head before requesting RPC status', async () => {
  let requests = 0;
  const result = await repairSystemIncomePolBlocks({ query: async () => ({ rows: [] }) }, {
    activationHeight: 100,
    resolveHead: async () => ({ height: 99, source: 'chain-block-headers' }),
    fetchRpc: async () => { requests++; return { result: { sync_info: { latest_block_height: '99' } } }; }
  });
  assert.equal(result.headHeight, 99);
  assert.equal(requests, 0);
});

test('SIPOL repair drains in-flight workers and stops new requests before rejecting after a provider failure', async () => {
  const store = repairStore(100, 105);
  const slowStarted = deferred();
  const releaseSlow = deferred();
  const calls = [];
  let active = 0;
  let settled = false;
  const repair = repairSystemIncomePolBlocks(store, {
    activationHeight: 100,
    headHeight: 105,
    limit: 6,
    concurrency: 2,
    async fetchRpc(endpoint, { height }) {
      assert.equal(endpoint, '/block_results');
      calls.push(height);
      active += 1;
      try {
        if (height === 101) {
          await slowStarted.promise;
          throw new Error('provider timeout at 101');
        }
        if (height === 102) {
          slowStarted.resolve();
          await releaseSlow.promise;
        }
        return blockResult(height);
      } finally {
        active -= 1;
      }
    }
  }).then(
    () => { settled = true; return null; },
    (error) => { settled = true; return error; }
  );

  await slowStarted.promise;
  await nextTurn();
  const rejectedWhileWorkerActive = settled && active > 0;
  releaseSlow.resolve();
  const error = await repair;
  await nextTurn();

  assert.equal(rejectedWhileWorkerActive, false, 'the caller must retain its advisory-lock client until all provider work drains');
  assert.match(error?.message || '', /provider timeout at 101/);
  assert.equal(active, 0);
  assert.deepEqual(calls, [100, 101, 102], 'a failed run must not start more queued provider requests');
  assert.deepEqual([...store.ledger.keys()].sort((a, b) => a - b), [100, 102]);
});

test('SIPOL repair retains successful header pages when a later header request fails', async () => {
  const store = repairStore(100, 140);
  store.headers.clear();
  const calls = [];
  await assert.rejects(repairSystemIncomePolBlocks(store, {
    activationHeight: 100,
    headHeight: 140,
    limit: 41,
    concurrency: 1,
    async fetchRpc(endpoint, { minHeight, maxHeight }) {
      assert.equal(endpoint, '/blockchain');
      calls.push({ minHeight, maxHeight });
      if (minHeight === 120) throw new Error('header page timeout');
      return { result: { block_metas: Array.from({ length: maxHeight - minHeight + 1 }, (_, index) => ({
        block_id: { hash: `BLOCK${minHeight + index}` },
        header: {
          height: String(minHeight + index),
          time: new Date(Date.UTC(2026, 8, 2, 0, 0, index * 6)).toISOString()
        }
      })) } };
    }
  }), /header page timeout/);
  assert.deepEqual(calls, [
    { minHeight: 100, maxHeight: 119 },
    { minHeight: 120, maxHeight: 139 }
  ]);
  assert.deepEqual([...store.headers.keys()], Array.from({ length: 20 }, (_, index) => 100 + index));
  assert.equal(store.ledger.size, 0);
});

test('SIPOL repair reuses complete stored event headers and fetches only headers missing accounting fields', async () => {
  const store = repairStore(100, 102);
  for (const header of store.headers.values()) {
    Object.assign(header, {
      source: 'liquify-ws',
      system_income_pol_observed: true,
      system_income_total_e8: '12',
      system_income_pol_reward_e8: '2',
      system_income_pol_deployments: [],
      system_income_pol_pool_fees: []
    });
  }
  store.headers.get(101).system_income_total_e8 = null;
  store.headers.get(102).system_income_pol_pool_fees = null;
  const calls = [];
  const result = await repairSystemIncomePolBlocks(store, {
    activationHeight: 100,
    headHeight: 102,
    limit: 3,
    concurrency: 1,
    async fetchRpc(endpoint, { height }) {
      assert.equal(endpoint, '/block_results');
      calls.push(height);
      return blockResult(height);
    }
  });
  assert.deepEqual(calls, [101, 102]);
  assert.equal(store.ledger.get(100).source, 'liquify-ws');
  assert.equal(store.ledger.get(100).system_income_e8, '12');
  assert.equal(result.repaired, 3);
  assert.equal(result.complete, true);
});
