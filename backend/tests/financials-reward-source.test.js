import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  parseFinancialRevshareBlock,
  readFinancialRewardAccountingDays,
  saveFinancialRewardBlocks,
  repairFinancialRewardBlocks,
  fetchFinancialRewardBlockBatch
} from '../src/shared/financials-reward-source.js';

const event = (payout, extra = {}) => ({
  type: 'rev_share',
  attributes: Object.entries({ thorname: 'affiliate', payout, ...extra })
    .map(([key, value]) => ({ key, value: String(value) }))
});

test('finalized REVSHARE payouts are summed exactly, independently of transaction events', () => {
  const result = parseFinancialRevshareBlock({ result: {
    height: '28204118',
    finalize_block_events: [event('147625'), event('9007199254740993'), event('0')],
    txs_results: [{ events: [event('147625')] }]
  } }, 28204118);
  assert.equal(result.revshareE8, '9007199254888618');
  assert.equal(result.height, 28204118);
});

test('an explicitly observed empty finalized event lane proves zero REVSHARE', () => {
  assert.equal(parseFinancialRevshareBlock({ result: {
    height: '28204118', finalize_block_events: []
  } }, 28204118).revshareE8, '0');
});

test('missing finalized events and wrong-height RPC responses cannot become zero payouts', () => {
  assert.throws(() => parseFinancialRevshareBlock({ result: { height: '28204118' } }, 28204118), /finalized/i);
  assert.throws(() => parseFinancialRevshareBlock({ result: {
    height: '28204119', finalize_block_events: []
  } }, 28204118), /height/i);
});

test('malformed payout cannot be silently dropped from a complete block', () => {
  assert.throws(() => parseFinancialRevshareBlock({ result: {
    height: '28204118', finalize_block_events: [event('-1')]
  } }, 28204118), /payout/i);
});

test('NewBlock events and legacy base64 attributes use the same exact payout parser', () => {
  const encoded = event('147625');
  encoded.attributes = encoded.attributes.map(({ key, value }) => ({
    key: Buffer.from(key).toString('base64'), value: Buffer.from(value).toString('base64')
  }));
  assert.equal(parseFinancialRevshareBlock({
    block: { header: { height: '28204118' } }, result_finalize_block: { events: [encoded] }
  }, 28204118).revshareE8, '147625');
});

test('full block responses capture compact Reserve evidence without refetching events', () => {
  const parsed = parseFinancialRevshareBlock({ result: {
    height: '28204118', txs_results: [], finalize_block_events: [event('147625')]
  } }, 28204118);
  assert.equal(parsed.reserveObservation.schemaVersion, 1);
  assert.equal(parsed.reserveObservation.height, 28204118);
  assert.equal(parsed.reserveObservation.reserveDeltaE8, '0');
  assert.equal(parsed.reserveObservation.rewardEventCount, 0);
});

test('invalid Reserve evidence cannot erase an independently valid finalized payout', () => {
  const parsed = parseFinancialRevshareBlock({ result: {
    height: '28204118', txs_results: [], finalize_block_events: [event('147625'), { type: 'rewards' }]
  } }, 28204118);
  assert.equal(parsed.revshareE8, '147625');
  assert.equal(parsed.reserveObservation, null);
  assert.match(parsed.reserveObservationError, /Reserve/);
});

test('complete accounting requires exact contiguous block coverage and both interval boundaries', async () => {
  const from = Date.parse('2026-10-11T00:00:00Z') / 1000;
  const row = { from, through: from + 86400, previous_height: '28190000', next_height: '28204001',
    first_height: '28190001', last_height: '28204000', observed_blocks: '14000', revshare_e8: '39590000000' };
  const read = (overrides) => readFinancialRewardAccountingDays({ query: async () => ({ rows: [{ ...row, ...overrides }] }) },
    { from, through: from + 86400 });
  assert.equal((await read({}))['2026-10-11'].revshareE8, '39590000000');
  assert.equal((await read({ observed_blocks: '13999' }))['2026-10-11'].revshareE8, null);
  assert.equal((await read({ previous_height: null }))['2026-10-11'].complete, false);
  assert.equal((await read({ next_height: null }))['2026-10-11'].complete, false);
});

test('a chain-halt interval with adjacent bounding blocks proves zero payouts', async () => {
  const from = Date.parse('2026-10-11T00:00:00Z') / 1000;
  const days = await readFinancialRewardAccountingDays({ query: async () => ({ rows: [{
    from, through: from + 86400, previous_height: '28190000', next_height: '28190001',
    first_height: null, last_height: null, observed_blocks: '0', revshare_e8: '0'
  }] }) }, { from, through: from + 86400 });
  assert.equal(days['2026-10-11'].revshareE8, '0');
  assert.equal(days['2026-10-11'].complete, true);
});

test('pre-REVSHARE history has a provenance-marked zero independently of missing emissions', async () => {
  const from = Date.parse('2026-10-05T00:00:00Z') / 1000;
  const days = await readFinancialRewardAccountingDays({ query: async () => ({ rows: [] }) },
    { from, through: from + 2 * 86400 });
  assert.equal(Object.keys(days).length, 2);
  assert.equal(days['2026-10-06'].revshareE8, '0');
  assert.equal(days['2026-10-06'].method, 'before-first-finalized-revshare-payout');
  assert.equal(days['2026-10-06'].reserveEmissionsE8, null);
  assert.equal(days['2026-10-06'].emissionsComplete, false);
});

test('exact emissions are independent of REVSHARE coverage and require every block with the exact method', async () => {
  const from = Date.parse('2026-10-05T00:00:00Z') / 1000;
  const read = (emissionCount) => readFinancialRewardAccountingDays({ query: async () => ({ rows: [{
    from, through: from + 86400, previous_height: '28099999', next_height: '28100003',
    first_height: '28100000', last_height: '28100002', observed_blocks: '3', revshare_e8: '0',
    emissions_observed_blocks: String(emissionCount), reserve_emissions_e8: '14466'
  }] }) }, { from, through: from + 86400 });
  const complete = (await read(3))['2026-10-05'];
  assert.equal(complete.complete, true);
  assert.equal(complete.emissionsComplete, true);
  assert.equal(complete.reserveEmissionsE8, '14466');
  const incomplete = (await read(2))['2026-10-05'];
  assert.equal(incomplete.complete, true);
  assert.equal(incomplete.emissionsComplete, false);
  assert.equal(incomplete.reserveEmissionsE8, null);
});

test('the first payout day starts at the verified first height, not midnight-inferred historical zero rows', async () => {
  const from = Date.parse('2026-10-07T00:00:00Z') / 1000;
  const days = await readFinancialRewardAccountingDays({ query: async () => ({ rows: [{
    from, through: from + 86400, previous_height: '28133901', next_height: '28146081',
    first_height: '28146078', last_height: '28146080', observed_blocks: '3', revshare_e8: '250'
  }] }) }, { from, through: from + 86400 });
  assert.equal(days['2026-10-07'].revshareE8, '250');
  assert.equal(days['2026-10-07'].expectedBlocks, 3);
});

test('persisted payouts retain e8 precision and reject unverified observations', async () => {
  let written;
  const client = { query: async (_sql, values) => { written = JSON.parse(values[0]); return { rowCount: 1 }; } };
  await saveFinancialRewardBlocks(client, [{ height: 28204118, blockTime: '2026-10-11T23:59:59.672Z', revshareE8: '9007199254740993' }]);
  assert.equal(written[0].revshare_e8, '9007199254740993');
  await assert.rejects(saveFinancialRewardBlocks(client, [{ height: 28204119, blockTime: '2026-10-12T00:00:05Z' }]), /observation/i);
});

test('compact Reserve evidence is retained with signed precision for later exact replay', async () => {
  let written;
  const client = { query: async (_sql, values) => { written = JSON.parse(values[0]); return { rowCount: 1 }; } };
  const reserveObservation = { schemaVersion: 1, height: 28204118,
    reserveDeltaE8: '-9007199254740993', afterRewardsDeltaE8: '-100',
    rewardTransfersE8: '282329907', rewardEventCount: 1, configChanges: [] };
  await saveFinancialRewardBlocks(client, [{ height: 28204118, blockTime: '2026-10-11T23:59:59.672Z',
    revshareE8: '147625', reserveObservation, reserveEmissionsE8: '4822', emissionsMethod: 'historical-reserve-formula-v1' }]);
  assert.deepEqual(written[0].reserve_observation, reserveObservation);
  assert.equal(written[0].reserve_emissions_e8, '4822');
  await assert.rejects(saveFinancialRewardBlocks(client, [{ height: 28204118, blockTime: '2026-10-11T23:59:59.672Z',
    revshareE8: '147625', reserveObservation: { ...reserveObservation, height: 28204119 } }]), /observation/i);
});

test('explicit repair bounds and zero-payout storage cover emissions before the first REVSHARE payout', async () => {
  let selected;
  await repairFinancialRewardBlocks({ query: async (_sql, values) => { selected = values; return { rows: [] }; } },
    { minHeight: 28049914 });
  assert.equal(selected[0], 28049914);
  await repairFinancialRewardBlocks({ query: async (_sql, values) => { selected = values; return { rows: [] }; } },
    { from: Date.parse('2026-10-01T00:00:00Z') / 1000 });
  assert.equal(selected[0], 1, 'an explicit date start must not retain the later first-payout height floor');
  let written;
  await saveFinancialRewardBlocks({ query: async (_sql, values) => { written = JSON.parse(values[0]); return { rowCount: 1 }; } },
    [{ height: 28049914, blockTime: '2026-10-01T00:00:01Z', revshareE8: '0' }]);
  assert.equal(written[0].height, 28049914);
});

test('bounded repair checkpoints successful batches and preserves progress on a later failure', async () => {
  const headers = [4, 3, 2, 1].map((offset) => ({ height: 28204118 + offset, block_time: '2026-10-12T00:00:30Z' }));
  const batches = [];
  const persisted = [];
  let calls = 0;
  await assert.rejects(repairFinancialRewardBlocks({ query: async () => ({ rows: headers }) }, {
    limit: 4, batchSize: 2,
    fetchBatch: async (heights) => {
      batches.push(heights);
      if (++calls === 2) throw new Error('provider unavailable');
      return heights.map((height) => ({ id: String(height), result: { height: String(height), finalize_block_events: [event('5')] } }));
    },
    save: async (_client, rows) => persisted.push(...rows)
  }), /provider unavailable/);
  assert.equal(batches.length, 2);
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0].revshareE8, '5');
});

test('archive repair respects the production RPC maximum of ten calls per batch', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({ height: 28232200 - index,
    block_time: '2026-10-13T23:57:00Z' }));
  const batches = [];
  await repairFinancialRewardBlocks({ query: async () => ({ rows }) }, {
    limit: 25, requestSpacingMs: 0,
    fetchBatch: async heights => {
      batches.push(heights.length);
      if (heights.length > 10) return { jsonrpc: '2.0', error: { code: -32600,
        message: 'Invalid Request', data: 'batch request exceeds maximum (10) allowed number of requests' } };
      return heights.map(height => ({ id: String(height), result: {
        height: String(height), txs_results: [], finalize_block_events: [] } }));
    }, save: async () => {}
  });
  assert.deepEqual(batches, [10, 10, 5]);
});

test('an oversized caller batch setting cannot exceed the production maximum', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ height: 28232200 - index,
    block_time: '2026-10-13T23:57:00Z' }));
  const batches = [];
  await repairFinancialRewardBlocks({ query: async () => ({ rows }) }, {
    batchSize: 50, requestSpacingMs: 0,
    fetchBatch: async (heights) => {
      batches.push(heights.length);
      return heights.map((height) => ({ id: String(height), result: {
        height: String(height), txs_results: [], finalize_block_events: [] } }));
    }, save: async () => {}
  });
  assert.deepEqual(batches, [10, 2]);
  await assert.rejects(fetchFinancialRewardBlockBatch({}, Array.from({ length: 11 }, (_, index) => 28232200 - index), {
    transport: async () => { throw new Error('transport must not start'); }
  }), /batch size.*10/);
});

test('a JSON-RPC batch rejection preserves provider error details instead of a generic array error', async () => {
  await assert.rejects(repairFinancialRewardBlocks({ query: async () => ({ rows: [
    { height: 28232200, block_time: '2026-10-13T23:57:00Z' }
  ] }) }, {
    fetchBatch: async () => ({ jsonrpc: '2.0', error: { code: -32600,
      message: 'Invalid Request', data: 'batch request exceeds maximum (10) allowed number of requests' } }),
    save: async () => { throw new Error('must not persist rejected data'); }
  }), /Invalid Request: batch request exceeds maximum \(10\)/);
});

test('repair keeps successful responses when another result in the same batch is missing', async () => {
  const persisted = [];
  const rows = [28204119, 28204118].map((height) => ({ height, block_time: '2026-10-12T00:00:30Z' }));
  await assert.rejects(repairFinancialRewardBlocks({ query: async () => ({ rows }) }, {
    fetchBatch: async () => [{ id: '28204119', result: { height: '28204119', finalize_block_events: [] } }],
    save: async (_client, observations) => persisted.push(...observations)
  }), /missing block 28204118/);
  assert.deepEqual(persisted.map((row) => row.height), [28204119]);
});

test('RPC batches use the allowlisted shared provider transport, cancellation and height-specific IDs', async () => {
  const controller = new AbortController();
  let request;
  await fetchFinancialRewardBlockBatch({}, [28204118, 28204119], {
    signal: controller.signal, transport: async (options) => { request = options; return []; }
  });
  assert.deepEqual(request.bases, ['https://gateway.liquify.com/chain/thorchain_rpc', 'https://public-thorchain-rpc.nativeswap.io']);
  assert.equal(request.request.signal, controller.signal);
  assert.equal(request.request.method, 'POST');
  assert.equal(typeof request.beforeRequest, 'function');
  assert.deepEqual(JSON.parse(request.request.body).map((row) => row.id), ['28204118', '28204119']);
});

test('collector cancellation never writes provider outages, but actual timeouts and unrelated failures still do', () => {
  // The config is immutable at import time: run with production cooldowns
  // explicitly enabled, without changing other tests' environment or globals.
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { fetchFinancialRewardBlockBatch } from './src/shared/financials-reward-source.js';
    import { requestFromProviders } from './src/lib/provider-client.js';
    import { createThorchainProviderPool } from '../shared/thorchain-provider-pool.js';
    const outcomes = [];
    for (const kind of ['collector-reason', 'collector-body-abort', 'provider-timeout', 'unrelated-failure']) {
      const controller = new AbortController();
      const providerPool = createThorchainProviderPool();
      const writes = [];
      const client = { query: async (sql, values) => {
        if (sql.includes('insert into provider_circuit_breakers')) writes.push(values);
        return { rows: [] };
      } };
      let started;
      const ready = new Promise(resolve => { started = resolve; });
      globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(
          kind === 'collector-body-abort' ? new DOMException('Body read canceled', 'AbortError')
            : kind === 'unrelated-failure' ? new Error('Independent provider failure') : signal.reason
        ), { once: true });
        started();
      });
      const pending = fetchFinancialRewardBlockBatch(client, [28204118], {
        signal: controller.signal,
        transport: options => requestFromProviders({ ...options, providerPool, timeoutMs: kind === 'provider-timeout' ? 5 : 500 })
      });
      await ready;
      if (kind !== 'provider-timeout') controller.abort(new Error('Collector shutting down'));
      await pending.catch(() => {});
      outcomes.push({ kind, writes: writes.length });
    }
    console.log(JSON.stringify(outcomes));
  `], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PROVIDER_COOLDOWN_ENABLED: 'true' } });
  // Independent provider timeouts record both failed hosts. Cancellation
  // prevents contacting the fallback or recording a shutdown as an outage.
  assert.deepEqual(JSON.parse(output).map((row) => row.writes), [0, 0, 2, 1]);
});
