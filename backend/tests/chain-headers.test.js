import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';

const {
  listMissingHeaderRanges,
  loadBlockIntervalSeries,
  normalizeChainHeader,
  parseChainHeaderFromNewBlock,
  repairChainHeaderGaps,
  serializeChainHead,
  upsertChainHeaders
} = await import('../src/shared/chain-headers.js');
const { createChainEventBroker, formatChainHeadSse } = await import('../src/lib/chain-event-broker.js');

function newBlockData(height, time, options = {}) {
  return {
    block_id: { hash: options.hash || `HASH${height}` },
    block: { header: { height: String(height), time } },
    result_finalize_block: {
      events: options.events || [],
      tx_results: options.txResults || []
    }
  };
}

test('chain header parser extracts the live timing and compact event hints', () => {
  const header = parseChainHeaderFromNewBlock(newBlockData(
    123,
    '2026-08-05T12:00:06.250Z',
    { events: [{ type: 'swap', attributes: [] }] }
  ));

  assert.deepEqual(header, {
    height: 123,
    blockHash: 'HASH123',
    blockTime: '2026-08-05T12:00:06.250Z',
    hasSwapEvents: true,
    source: 'liquify-ws'
  });
  assert.equal(normalizeChainHeader({ height: 0, blockTime: 'invalid' }), null);
  assert.deepEqual(serializeChainHead({ ...header, interval_ms: 6250 }), {
    height: 123,
    time: '2026-08-05T12:00:06.250Z',
    time_ms: Date.parse('2026-08-05T12:00:06.250Z'),
    interval_ms: 6250,
    block_hash: 'HASH123',
    has_swap_events: true,
    income_burn_e8: null,
    pol_reserve_reward_e8: null,
    pol_reserve_deployments: [],
    pol_reserve_pool_fees: [],
    source: 'liquify-ws'
  });
  assert.equal(serializeChainHead({ ...header, intervalMs: 6250 }).interval_ms, 6250);
});

test('consolidated parser adapts NewBlock finalize results without another RPC request', async () => {
  const {
    normalizeNewBlockForRujiraBaseFees,
    parseConsolidatedChainBlock
  } = await import('../src/shared/chain-stream.js');
  const data = newBlockData(200, '2026-08-05T12:01:00Z', {
    events: [
      { type: 'swap', attributes: [] },
      { type: 'rewards', attributes: [{ key: 'income_burn', value: '123456789' }] }
    ],
    txResults: [{ events: [{ type: 'message', attributes: [] }] }]
  });
  const payload = normalizeNewBlockForRujiraBaseFees(data, 200);
  const parsed = parseConsolidatedChainBlock({ data });

  assert.equal(payload.result.height, '200');
  assert.equal(payload.result.txs_results.length, 1);
  assert.equal(payload.result.finalize_block_events.length, 2);
  assert.equal(parsed.header.height, 200);
  assert.equal(parsed.header.hasSwapEvents, true);
  assert.equal(parsed.incomeBurnE8, '123456789');
  assert.deepEqual(parsed.baseFeePayload, payload);
});

test('missing height detection produces provider-safe pages and skips known headers', () => {
  assert.deepEqual(listMissingHeaderRanges([10, 11, 15, 18], 10, 20, 3), [
    { minHeight: 12, maxHeight: 14 },
    { minHeight: 16, maxHeight: 17 },
    { minHeight: 19, maxHeight: 20 }
  ]);
});

test('header upsert recalculates intervals around inserted ranges', async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('where height = any')) {
        return {
          rows: [
            {
              height: '100',
              block_hash: 'A',
              block_time: '2026-08-05T12:00:00Z',
              interval_ms: '6000',
              has_swap_events: false,
              source: 'liquify-rpc-repair'
            },
            {
              height: '101',
              block_hash: 'B',
              block_time: '2026-08-05T12:00:06Z',
              interval_ms: '6000',
              has_swap_events: true,
              source: 'liquify-ws'
            }
          ]
        };
      }
      return { rows: [], rowCount: 0 };
    }
  };

  const stored = await upsertChainHeaders(client, [
    {
      height: 101,
      blockHash: 'b',
      blockTime: '2026-08-05T12:00:06Z',
      hasSwapEvents: true,
      systemIncomePolObserved: true,
      systemIncomePolRewardE8: '7',
      systemIncomePolDeployments: [{ asset: 'BTC.BTC', runeE8: '5', unitsE8: '2' }],
      systemIncomePolPoolFees: [{ asset: 'BTC.BTC', feeE8: '3' }]
    },
    { height: 100, blockHash: 'a', blockTime: '2026-08-05T12:00:00Z', source: 'liquify-rpc-repair' }
  ]);

  assert.equal(stored.length, 2);
  assert.equal(stored[1].intervalMs, 6000);
  assert.match(queries[0].sql, /on conflict \(height\) do update/i);
  assert.equal(typeof queries[0].params[18], 'string');
  assert.deepEqual(JSON.parse(queries[0].params[18]), [{
    asset: 'BTC.BTC', runeE8: '5', unitsE8: '2', runeAddress: ''
  }]);
  assert.deepEqual(JSON.parse(queries[0].params[19]), [{ asset: 'BTC.BTC', feeE8: '3' }]);
  assert.match(queries[1].sql, /previous\.height = current\.height - 1/i);
  assert.deepEqual(queries[1].params, [100, 102]);
});

test('per-block endpoint returns compact tuples with incremental cursors', async () => {
  const { handleBlockProduction } = await import('../src/handlers/block-production.js');
  const client = {
    async query(sql, params) {
      assert.match(sql, /height > \$2/);
      assert.equal(params[1], 100);
      return {
        rows: [
          {
            height: '101',
            block_hash: 'A',
            block_time: '2026-08-05T12:00:06Z',
            interval_ms: '6100',
            has_swap_events: false,
            source: 'liquify-ws'
          },
          {
            height: '103',
            block_hash: 'C',
            block_time: '2026-08-05T12:00:19Z',
            interval_ms: '6900',
            has_swap_events: true,
            source: 'liquify-ws'
          }
        ]
      };
    }
  };
  const payload = await loadBlockIntervalSeries(client, {
    afterHeight: 100,
    hours: 24,
    limit: 20_000,
    nowMs: Date.parse('2026-08-05T12:01:00Z')
  });

  assert.deepEqual(payload.columns, ['height', 'time_ms', 'interval_ms', 'has_swap_events']);
  assert.deepEqual(payload.points, [
    [101, Date.parse('2026-08-05T12:00:06Z'), 6100, 0],
    [103, Date.parse('2026-08-05T12:00:19Z'), 6900, 1]
  ]);
  assert.deepEqual(payload.gaps, [[102, 102]]);
  assert.equal(payload.as_of_height, 103);

  const response = await handleBlockProduction({}, new URL(
    'http://localhost/block-production?hours=12&after_height=100'
  ), {
    client,
    nowMs: Date.parse('2026-08-05T12:01:00Z')
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.body.window_hours, 12);
});

test('gap repair fetches only missing pages and persists a durable repair cursor', async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('select min(height)')) return { rows: [{ min_height: '100' }] };
      if (sql.includes('select height') && sql.includes('between')) {
        return { rows: [{ height: '100' }] };
      }
      if (sql.includes('where height = any')) {
        return {
          rows: [{
            height: '99',
            block_hash: 'HASH99',
            block_time: '2026-08-05T11:59:54Z',
            interval_ms: '6000',
            has_swap_events: false,
            source: 'liquify-rpc-repair'
          }]
        };
      }
      return { rows: [], rowCount: sql.trim().startsWith('delete') ? 2 : 0 };
    }
  };
  const rpcCalls = [];
  const fetchRpc = async (path, params) => {
    rpcCalls.push({ path, params });
    assert.equal(path, '/blockchain');
    return {
      result: {
        block_metas: [{
          block_id: { hash: 'HASH99' },
          header: { height: '99', time: '2026-08-05T11:59:54Z' }
        }]
      }
    };
  };

  const result = await repairChainHeaderGaps(client, {
    head: { height: 100, blockTime: '2026-08-05T12:00:00Z' },
    bootstrapBlocks: 3,
    maxBlocks: 3,
    batchDelayMs: 0,
    fetchRpc
  });

  assert.deepEqual(rpcCalls, [{ path: '/blockchain', params: { minHeight: 98, maxHeight: 99 } }]);
  assert.equal(result.repairedHeaders, 1);
  assert.equal(result.requestedRanges, 1);
  assert.ok(queries.some(({ sql }) => sql.includes('insert into chain_stream_state')));
});

test('chain event broker replays the latest durable head and fans out notifications', async () => {
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.queries = [];
      this.released = false;
    }

    async query(sql) {
      this.queries.push(sql);
      return { rows: [] };
    }

    release() {
      this.released = true;
    }
  }
  class FakeResponse extends EventEmitter {
    constructor() {
      super();
      this.frames = [];
      this.headers = null;
      this.destroyed = false;
      this.writableEnded = false;
    }

    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    }

    write(frame) {
      this.frames.push(frame);
    }

    end() {
      this.writableEnded = true;
      this.emit('close');
    }
  }

  const client = new FakeClient();
  const intervals = [];
  const broker = createChainEventBroker({
    getClient: async () => client,
    loadLatest: async () => ({ height: 100, time: '2026-08-05T12:00:00Z', interval_ms: 6000 }),
    setIntervalFn(callback, delay) {
      const timer = { callback, delay };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn() {}
  });
  await broker.start();

  const request = new EventEmitter();
  const response = new FakeResponse();
  let closed = 0;
  broker.subscribe(request, response, () => { closed += 1; });
  assert.equal(response.status, 200);
  assert.match(response.headers['Content-Type'], /text\/event-stream/);
  assert.match(response.frames.join(''), /id: 100/);

  client.emit('notification', {
    channel: 'boonetools_chain_head',
    payload: JSON.stringify({
      height: 101,
      time: '2026-08-05T12:00:06Z',
      interval_ms: 6000,
      has_swap_events: true
    })
  });
  assert.match(response.frames.at(-1), /event: head/);
  assert.match(response.frames.at(-1), /"has_swap_events":true/);
  intervals[0].callback();
  assert.equal(response.frames.at(-1), ': keepalive\n\n');

  request.emit('close');
  assert.equal(closed, 1);
  assert.equal(broker.getClientCount(), 0);
  await broker.stop();
  assert.equal(client.released, true);
  assert.equal(formatChainHeadSse({ height: 0, time: 'bad' }), '');
});

test('migration and deployment install one persistent consolidated listener', async () => {
  const [migration, unit, deploy] = await Promise.all([
    readFile(new URL('../migrations/043_chain_block_headers.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-chain-stream-listener.service', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/deploy-boonetools-backend-remote.sh', import.meta.url), 'utf8')
  ]);
  const persistentStart = deploy.indexOf('start_persistent_services()');
  const persistentEnd = deploy.indexOf('\n}\n', persistentStart);
  const persistentFunction = deploy.slice(persistentStart, persistentEnd);

  assert.match(migration, /create table if not exists public\.chain_block_headers/i);
  assert.match(migration, /height bigint primary key/i);
  assert.match(migration, /interval_ms integer/i);
  assert.match(unit, /src\/chain-stream-listener\.js/);
  assert.match(persistentFunction, /boonetools-chain-stream-listener\.service/);
  assert.doesNotMatch(persistentFunction, /rujira-(?:base-fees|reserve)-listener/);
  assert.doesNotMatch(persistentFunction, /rapid-swap-listener/);
});
