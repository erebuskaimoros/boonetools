import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test';

const {
  ANALYTICS_DATABASE_READ_MODEL_REFRESHERS,
  refreshAnalyticsReadModels
} = await import('../src/shared/analytics-read-models.js');
const { runAnalyticsReadModels } = await import('../src/jobs/analytics-read-models.js');
const {
  NODE_VOTES_SUMMARY_LOCK_KEY,
  runNodeVotesSummary
} = await import('../src/jobs/node-votes-summary.js');
const {
  RAPID_SWAPS_MARKET_HISTORY_LOCK_KEY,
  runRapidSwapsMarketHistory
} = await import('../src/jobs/rapid-swaps-market-history.js');

async function captureJob(run, expectedLockKey) {
  const client = { name: 'locked-client' };
  const calls = [];
  const result = await run({
    force: true,
    lockRunner: async (lockKey, callback) => {
      calls.push({ type: 'lock', lockKey });
      return callback(client);
    },
    refresh: async (options) => {
      calls.push({ type: 'refresh', options });
      return { ok: true, lane: expectedLockKey };
    }
  });
  assert.equal(calls[0].lockKey, expectedLockKey);
  assert.equal(calls[1].options.client, client);
  assert.equal(calls[1].options.force, true);
  assert.equal(calls[1].options.lockRunner, undefined);
  assert.equal(calls[1].options.refresh, undefined);
  assert.deepEqual(result, { ok: true, lane: expectedLockKey });
}

test('generic analytics loop contains only database-backed refresh lanes', () => {
  assert.deepEqual(
    ANALYTICS_DATABASE_READ_MODEL_REFRESHERS.map(([name]) => name),
    [
      'rapidSwaps',
      'appLayerReservePayments',
      'appLayerBaseLayerEarnings',
      'appLayerBaseFees',
      'tcFeeDash',
      'wasmArbEconomics'
    ]
  );
});

test('generic analytics loop continues database refreshes after one model fails', async () => {
  const calls = [];
  const result = await refreshAnalyticsReadModels({
    refreshers: [
      ['first', async () => {
        calls.push('first');
        throw new Error('first failed');
      }],
      ['second', async () => {
        calls.push('second');
        return { ok: true };
      }]
    ]
  });
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(result.first.ok, false);
  assert.match(result.first.error, /first failed/);
  assert.deepEqual(result.second, { ok: true });
});

test('analytics database job owns its original advisory lock', async () => {
  await captureJob(runAnalyticsReadModels, 'boonetools:analytics-read-models');
});

test('analytics database job reports a failed unit after every lane had a chance to run', async () => {
  await assert.rejects(() => runAnalyticsReadModels({
    lockRunner: async (_lockKey, callback) => callback({ name: 'client' }),
    refresh: async () => ({
      rapidSwaps: { ok: false, error: 'query timed out' },
      appLayerBaseFees: { ok: true }
    })
  }), /rapidSwaps: query timed out/);
});

test('Node Votes summary has an independent advisory lock', async () => {
  await captureJob(runNodeVotesSummary, NODE_VOTES_SUMMARY_LOCK_KEY);
});

test('Rapid Swaps market history has an independent advisory lock', async () => {
  await captureJob(runRapidSwapsMarketHistory, RAPID_SWAPS_MARKET_HISTORY_LOCK_KEY);
});

test('Node Votes provider failure preserves a usable last-good summary', async () => {
  const previous = {
    payload: {
      chain_state: { complete: true },
      by_vote: [],
      by_node: []
    }
  };
  const result = await runNodeVotesSummary({
    lockRunner: async (_key, callback) => callback({ name: 'client' }),
    refresh: async () => { throw new Error('thornode unavailable'); },
    readModel: async () => previous
  });
  assert.equal(result.ok, true);
  assert.equal(result.stale, true);
  assert.equal(result.reason, 'preserved_last_good');
  assert.equal(result.model, previous);
});

test('Node Votes provider failure rejects without a usable prior summary', async () => {
  await assert.rejects(() => runNodeVotesSummary({
    lockRunner: async (_key, callback) => callback({ name: 'client' }),
    refresh: async () => { throw new Error('thornode unavailable'); },
    readModel: async () => null
  }), /thornode unavailable/);
});

test('market-history provider failure preserves complete hourly and daily history', async () => {
  const previous = {
    payload: {
      segments: {
        hour: { intervals: [{ startTime: '1' }] },
        day: { intervals: [{ startTime: '1' }] }
      }
    }
  };
  const result = await runRapidSwapsMarketHistory({
    lockRunner: async (_key, callback) => callback({ name: 'client' }),
    refresh: async () => { throw new Error('providers unavailable'); },
    readModel: async () => previous
  });
  assert.equal(result.ok, true);
  assert.equal(result.stale, true);
  assert.equal(result.reason, 'preserved_last_good');
  assert.equal(result.model, previous);
});

test('market-history provider failure rejects without both prior segments', async () => {
  await assert.rejects(() => runRapidSwapsMarketHistory({
    lockRunner: async (_key, callback) => callback({ name: 'client' }),
    refresh: async () => { throw new Error('providers unavailable'); },
    readModel: async () => ({
      payload: { segments: { hour: { intervals: [{ startTime: '1' }] } } }
    })
  }), /providers unavailable/);
});
