import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
    ['rapidSwaps', 'appLayerReservePayments', 'appLayerBaseLayerEarnings', 'appLayerBaseFees', 'tcFeeDash']
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

test('job registry, systemd timers, and deploy keep provider lanes isolated and recoverable', async () => {
  const [registry, nodeService, nodeTimer, marketService, marketTimer, statusService, liveStatusService, liveStatusTimer, deployScript, perfSmoke] = await Promise.all([
    readFile(new URL('../src/run-job.js', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-node-votes-summary.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-node-votes-summary.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-rapid-swaps-market-history.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-rapid-swaps-market-history.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-status-dashboard.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-status-live.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-status-live.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/deploy-boonetools-backend.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/perf-smoke.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(registry, /'node-votes-summary': runNodeVotesSummary/);
  assert.match(registry, /'rapid-swaps-market-history': runRapidSwapsMarketHistory/);
  assert.match(registry, /'status-live-scheduler': runStatusLiveScheduler/);
  assert.match(nodeService, /ExecStart=.* node-votes-summary/);
  assert.match(nodeService, /TimeoutStartSec=45s/);
  assert.match(nodeTimer, /OnUnitActiveSec=1min/);
  assert.match(marketService, /ExecStart=.* rapid-swaps-market-history/);
  assert.match(marketService, /TimeoutStartSec=5min/);
  assert.match(marketTimer, /OnUnitActiveSec=30min/);
  assert.match(statusService, /After=.*boonetools-node-votes-summary\.service/);
  assert.match(statusService, /Wants=.*boonetools-node-votes-summary\.service/);
  assert.match(statusService, /Wants=.*boonetools-status-live\.service/);
  assert.match(liveStatusService, /ExecStart=.* status-live-scheduler/);
  assert.match(liveStatusService, /TimeoutStartSec=20s/);
  assert.match(liveStatusTimer, /OnUnitActiveSec=15s/);
  for (const unit of ['boonetools-node-votes-summary', 'boonetools-rapid-swaps-market-history']) {
    assert.match(deployScript, new RegExp(`${unit}\\.timer`));
    assert.match(deployScript, new RegExp(`systemctl start ${unit}\\.service`));
  }
  assert.match(deployScript, /ROLLBACK_DEST\/systemd/);
  assert.match(deployScript, /ROLLBACK_DEST\/Caddyfile/);
  assert.match(deployScript, /\[\[ -f "\$unit_path" \]\] \|\| continue/);
  assert.match(deployScript, /systemctl restart boonetools-api\.service/);
  assert.match(deployScript, /Writer unit remained active after stop/);
  assert.match(deployScript, /start_remote_unit_with_retry boonetools-app-layer-live-state\.service/);
  assert.match(deployScript, /start_remote_unit_with_retry boonetools-status-dashboard\.service/);
  assert.match(deployScript, /start_remote_unit_with_retry boonetools-status-live\.service/);
  const statusPrime = deployScript.indexOf('Priming compact Status read model');
  const liveStatusPrime = deployScript.indexOf('Priming compact live Status read model');
  const publicSmoke = deployScript.indexOf('Verifying public latency, payload, and compression budgets');
  const timerStart = deployScript.indexOf('Starting scheduler and maintenance timers after successful priming and smoke checks');
  assert.ok(liveStatusPrime >= 0 && liveStatusPrime < statusPrime);
  assert.ok(statusPrime >= 0 && statusPrime < publicSmoke);
  assert.ok(publicSmoke < timerStart);
  assert.match(perfSmoke, /allowStale: false/);
  assert.match(perfSmoke, /stale response\(s\)/);
  assert.match(perfSmoke, /response content type was not JSON/);
});
