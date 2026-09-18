import assert from 'node:assert/strict';
import test from 'node:test';
import { runProtocolFeeComparison } from '../src/jobs/protocol-fee-comparison.js';
import { collectComparison, emptyComparisonCache } from '../src/protocol-fee-comparison/collector.js';

const NOW = Date.parse('2026-09-03T12:00:00Z');
const day = (withFlip = true) => ({
  earnings: { liquidityFees: '200000000', blockRewards: '100000000', runePriceUSD: '1' },
  nearRevenue: 3, nearPrice: 1, nearIssuance: 1, nearIssuanceMethod: 'dashboard-model',
  wallets: { frontend_near: 0, other_near: 1, source: 'fastnear-transfers-v1' },
  chainflipRevenue: 4, flipPrice: 1,
  ...(withFlip ? { flipIssuance: { atomic: '1000000000000000000' } } : {})
});

function database(cache) {
  const published = [], saved = [];
  return { published, saved, async query(sql, args = []) {
    if (/select namespace/.test(sql)) return { rows: [{ payload_json: cache,
      observed_at: '2026-09-02T12:00:00Z', expires_at: '2026-09-02T18:00:00Z' }] };
    if (/insert into source_observations/.test(sql)) {
      const payload = JSON.parse(args[2]); saved.push(payload);
      return { rows: [{ payload_json: payload, observed_at: args[4], expires_at: args[5] }] };
    }
    if (/insert into api_read_models/.test(sql)) {
      published.push(structuredClone(args[2]));
      return { rows: [{ model_key: args[0], payload_json: args[2], generated_at: args[4], fresh_until: args[6] }] };
    }
    return { rows: [] };
  } };
}

test('job publishes recovered history before acquisition and each checkpoint before a later interruption', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Tests must not call providers'); });
  const cache = emptyComparisonCache(); cache.days['2026-09-01'] = day();
  const client = database(cache);
  let enteredCollector = false;
  await assert.rejects(runProtocolFeeComparison({ now: NOW, lockRunner: async (_key, run) => run(client),
    collector: async ({ cache: current, save }) => {
      enteredCollector = true;
      assert.equal(client.published.length, 1, 'prior checkpoints must be public before any network acquisition');
      assert.equal(client.published[0].throughDay, '2026-09-01');
      assert.equal(client.published[0].stale, true, 'recovery publication is not a completed source refresh');
      current.days['2026-09-02'] = day();
      await save(current);
      assert.equal(client.saved.length, 1);
      assert.equal(client.published.at(-1).throughDay, '2026-09-02');
      assert.equal(client.published.at(-1).months.at(-1).protocols.chainflip.netUsd, 6);
      throw new Error('simulated process interruption after durable checkpoint');
    }
  }), /simulated process interruption/);
  assert.equal(enteredCollector, true);
  assert.equal(client.published.at(-1).throughDay, '2026-09-02');
});

test('collector stops starting days at its runtime budget and returns saved progress for publication', async () => {
  const cache = emptyComparisonCache();
  cache.days['2026-09-01'] = day(false); cache.days['2026-09-02'] = day(false);
  let elapsed = 0;
  const calls = [], saved = [];
  const result = await collectComparison({ cache, now: NOW, startDay: '2026-09-01', maxRunMs: 10, clock: () => elapsed,
    request: async () => { throw new Error('upstream unavailable'); }, nearIssuanceReader: async () => [],
    chainflipReader: { boundaries: {}, issuance: async date => {
      calls.push(date); elapsed += 11;
      return { atomic: '1000000000000000000', start: { height: 1 }, end: { height: 2 } };
    } }, save: async (current, payload) => saved.push({ cache: structuredClone(current), payload })
  });
  assert.deepEqual(calls, ['2026-09-02'], 'do not start another day after the budget expires');
  assert.equal(cache.days['2026-09-01'].flipIssuance, undefined);
  assert.ok(saved.some(item => item.cache.days['2026-09-02'].flipIssuance));
  assert.equal(saved.at(-1).payload.throughDay, '2026-09-02');
  assert.match(result.payload.errors.join(' '), /budget|deadline|deferred/i);
});

test('collector budget aborts an in-flight request and prevents new source calls', { timeout: 2000 }, async () => {
  let calls = 0, aborted = false;
  const result = await collectComparison({ now: NOW, startDay: '2026-09-01', maxRunMs: 25,
    request: async (_url, options) => {
      calls++;
      assert.ok(options?.signal, 'collector passes an abort signal to transport');
      await new Promise((resolve, reject) => {
        const abort = () => { aborted = true; reject(options.signal.reason || new Error('aborted')); };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
      });
    }
  });
  assert.equal(aborted, true);
  assert.equal(calls, 1, 'remaining sources must be deferred after the deadline');
  assert.match(result.payload.errors.join(' '), /budget|deadline|deferred/i);
});
