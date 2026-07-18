import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { requestFromProviders } from '../src/lib/provider-client.js';
import { createRecordedJobRunner, runRecordedJob } from '../src/lib/recorded-job.js';
import {
  NEW_BLOCK_SUBSCRIPTION,
  createTendermintBlockStream,
  parseTendermintNewBlockMessage
} from '../src/lib/tendermint-block-stream.js';
import { TtlSingleFlightCache } from '../src/lib/ttl-cache.js';

function response(body, status = 200, statusText = 'OK', headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get(name) {
        return headers[String(name || '').toLowerCase()] || null;
      }
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
  };
}

test('requestFromProviders centralizes ordered fallback and stop policy', async () => {
  const calls = [];
  const payload = await requestFromProviders({
    bases: ['https://primary.test', 'https://fallback.test'],
    path: '/status',
    fetchImpl: async (url) => {
      calls.push(url);
      return url.startsWith('https://primary.test')
        ? response({ error: 'unavailable' }, 503, 'Unavailable')
        : response({ height: 123 });
    }
  });

  assert.deepEqual(payload, { height: 123 });
  assert.deepEqual(calls, [
    'https://primary.test/status',
    'https://fallback.test/status'
  ]);

  const rateLimitCalls = [];
  const rateLimitError = await requestFromProviders({
      bases: ['https://primary.test', 'https://fallback.test'],
      path: '/status',
      fetchImpl: async (url) => {
        rateLimitCalls.push(url);
        return response('rate limited', 429, 'Too Many Requests', { 'retry-after': '7200' });
      },
      shouldStop: (error) => error.status === 429
    }).catch((error) => error);
  assert.match(rateLimitError.message, /429/);
  assert.equal(rateLimitError.retryAfterSeconds, 7200);
  assert.deepEqual(rateLimitCalls, ['https://primary.test/status']);
});

test('TtlSingleFlightCache coalesces loads and can serve stale data on refresh failure', async () => {
  let now = 1000;
  let loadCount = 0;
  let resolveLoad;
  const cache = new TtlSingleFlightCache({ ttlMs: 50, now: () => now });
  const loader = () => {
    loadCount += 1;
    return new Promise((resolve) => {
      resolveLoad = resolve;
    });
  };

  const first = cache.getOrLoad('snapshot', loader);
  const second = cache.getOrLoad('snapshot', loader);
  assert.equal(loadCount, 0);
  await Promise.resolve();
  assert.equal(loadCount, 1);
  resolveLoad({ height: 123 });
  assert.deepEqual(await first, { height: 123 });
  assert.deepEqual(await second, { height: 123 });
  assert.deepEqual(cache.get('snapshot'), { height: 123 });

  now += 51;
  const stale = await cache.getOrLoad(
    'snapshot',
    async () => {
      throw new Error('provider down');
    },
    {
      staleIfError: true,
      onStale: (value, error) => ({ ...value, stale: true, warning: error.message })
    }
  );
  assert.deepEqual(stale, { height: 123, stale: true, warning: 'provider down' });
});

test('runRecordedJob records success and failure with the existing domain table', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.startsWith('insert into test_job_runs')) {
        return { rows: [{ id: 'job-1' }] };
      }
      return { rows: [] };
    }
  };

  const result = await runRecordedJob(client, {
    tableName: 'test_job_runs',
    jobName: 'test-job',
    run: async () => ({ rows_seen: 7 })
  });
  assert.deepEqual(result, { ok: true, job_id: 'job-1', rows_seen: 7 });
  assert.equal(queries.length, 2);
  assert.equal(queries[1].params[2], 'success');
  assert.deepEqual(queries[1].params[4], { rows_seen: 7 });

  queries.length = 0;
  await assert.rejects(
    () => runRecordedJob(client, {
      tableName: 'test_job_runs',
      jobName: 'test-job',
      run: async () => {
        throw new Error('ingestion failed');
      }
    }),
    /ingestion failed/
  );
  assert.equal(queries[1].params[2], 'error');
  assert.equal(queries[1].params[3], 'ingestion failed');
  assert.deepEqual(queries[1].params[4], { error: 'ingestion failed' });
});

test('createRecordedJobRunner keeps advisory locking injectable', async () => {
  const locks = [];
  const client = {
    async query(sql) {
      return sql.startsWith('insert into') ? { rows: [{ id: 9 }] } : { rows: [] };
    }
  };
  const runner = createRecordedJobRunner({
    lockKey: 'boonetools:test',
    tableName: 'test_job_runs',
    jobName: 'test-job',
    run: async () => ({ complete: true }),
    lockRunner: async (key, callback) => {
      locks.push(key);
      return callback(client);
    }
  });

  assert.deepEqual(await runner(), {
    ok: true,
    job_id: '9',
    complete: true
  });
  assert.deepEqual(locks, ['boonetools:test']);
});

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    this.pings = 0;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  send(value) {
    this.sent.push(value);
  }

  ping() {
    this.pings += 1;
  }

  terminate() {
    this.readyState = 3;
    this.emit('close', 1006, 'stalled');
  }

  close() {
    this.readyState = 3;
    this.emit('close', 1000, 'closed');
  }
}

function newBlockMessage(height = 123, time = '2026-07-17T12:00:00Z') {
  return {
    result: {
      data: {
        value: {
          block: {
            header: { height: String(height), time }
          }
        }
      }
    }
  };
}

test('Tendermint block stream owns subscription, failover, stall, and shutdown lifecycle', async () => {
  FakeWebSocket.instances.length = 0;
  let now = 1000;
  const timeouts = [];
  const intervals = [];
  const blocks = [];
  const setTimeoutFn = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timeouts.push(timer);
    return timer;
  };
  const clearTimeoutFn = (timer) => {
    if (timer) timer.cleared = true;
  };
  const setIntervalFn = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    intervals.push(timer);
    return timer;
  };
  const clearIntervalFn = (timer) => {
    if (timer) timer.cleared = true;
  };

  const stream = createTendermintBlockStream({
    urls: ['wss://primary.test', 'wss://fallback.test'],
    WebSocketCtor: FakeWebSocket,
    now: () => now,
    setTimeoutFn,
    clearTimeoutFn,
    setIntervalFn,
    clearIntervalFn,
    stallMs: 20,
    pingIntervalMs: 50,
    stallCheckIntervalMs: 10,
    reconnectBaseMs: 5,
    reconnectMaxMs: 20,
    onBlock: (block) => blocks.push(block)
  });

  stream.start();
  const primary = FakeWebSocket.instances[0];
  assert.equal(primary.url, 'wss://primary.test');
  primary.open();
  assert.deepEqual(JSON.parse(primary.sent[0]), NEW_BLOCK_SUBSCRIPTION);

  primary.emit('message', Buffer.from(JSON.stringify(newBlockMessage())));
  await Promise.resolve();
  assert.equal(blocks[0].blockHeight, 123);
  assert.equal(blocks[0].blockTime, '2026-07-17T12:00:00.000Z');
  assert.equal(stream.getState().streamStatus, 'running');

  now += 21;
  intervals.find((timer) => timer.delay === 10).callback();
  assert.equal(stream.getState().currentUrl, 'wss://fallback.test');
  assert.equal(timeouts[0].delay, 5);

  timeouts[0].callback();
  const fallback = FakeWebSocket.instances[1];
  assert.equal(fallback.url, 'wss://fallback.test');
  stream.stop();
  assert.equal(fallback.listenerCount('close'), 0);
  assert.equal(timeouts.filter((timer) => !timer.cleared).length, 1);
});

test('parseTendermintNewBlockMessage ignores acknowledgements and invalid heights', () => {
  assert.equal(parseTendermintNewBlockMessage({ result: { query: "tm.event='NewBlock'" } }), null);
  assert.equal(parseTendermintNewBlockMessage(newBlockMessage(0)), null);
  assert.equal(parseTendermintNewBlockMessage(newBlockMessage(7)).blockHeight, 7);
});
