import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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

test('job registry, systemd timers, and deploy keep provider lanes isolated and recoverable', async () => {
  const [
    registry,
    apiService,
    backupService,
    nodeService,
    nodeTimer,
    marketService,
    marketTimer,
    statusService,
    liveStatusService,
    liveStatusTimer,
    thornodeCoreService,
    thornodeCoreTimer,
    bondRefreshTimer,
    voteBackfillTimer,
    deployScript,
    remoteDeployScript,
    frontendDeployScript,
    remoteFrontendDeployScript,
    sourceGuard,
    perfSmoke
  ] = await Promise.all([
    readFile(new URL('../src/run-job.js', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-api.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-db-backup.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-node-votes-summary.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-node-votes-summary.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-rapid-swaps-market-history.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-rapid-swaps-market-history.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-status-dashboard.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-status-live.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-status-live.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-thornode-core-snapshot.service', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-thornode-core-snapshot.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-bond-history-refresh.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../ops/systemd/boonetools-node-votes-backfill.timer', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/deploy-boonetools-backend.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/deploy-boonetools-backend-remote.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/deploy-boonetools-frontend.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/deploy-boonetools-frontend-remote.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/require-canonical-boonetools-repo.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/perf-smoke.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(registry, /'node-votes-summary': runNodeVotesSummary/);
  assert.match(registry, /'rapid-swaps-market-history': runRapidSwapsMarketHistory/);
  assert.match(registry, /'status-live-scheduler': runStatusLiveScheduler/);
  assert.match(registry, /'thornode-core-snapshot': runThorNodeCoreSnapshot/);
  assert.match(apiService, /WorkingDirectory=\/opt\/boonetools-backend\/current\/backend/);
  assert.match(apiService, /EnvironmentFile=\/opt\/boonetools-backend\/config\/backend\.env/);
  assert.match(backupService, /ExecStart=\/usr\/bin\/bash \/opt\/boonetools-backend\/current\/scripts\/boonetools-db-backup\.sh/);
  assert.match(nodeService, /ExecStart=.* node-votes-summary/);
  assert.match(nodeService, /TimeoutStartSec=45s/);
  assert.match(nodeTimer, /OnActiveSec=15s/);
  assert.match(nodeTimer, /OnUnitActiveSec=1min/);
  assert.match(marketService, /ExecStart=.* rapid-swaps-market-history/);
  assert.match(marketService, /TimeoutStartSec=5min/);
  assert.match(marketTimer, /OnActiveSec=45s/);
  assert.match(marketTimer, /OnUnitActiveSec=30min/);
  assert.match(statusService, /After=.*boonetools-node-votes-summary\.service/);
  assert.match(statusService, /Wants=.*boonetools-node-votes-summary\.service/);
  assert.match(statusService, /Wants=.*boonetools-status-live\.service/);
  assert.match(liveStatusService, /ExecStart=.* status-live-scheduler/);
  assert.match(liveStatusService, /TimeoutStartSec=20s/);
  assert.match(liveStatusTimer, /OnUnitActiveSec=15s/);
  assert.match(thornodeCoreService, /ExecStart=.* thornode-core-snapshot/);
  assert.match(thornodeCoreTimer, /OnUnitActiveSec=15s/);
  assert.match(liveStatusService, /After=.*boonetools-thornode-core-snapshot\.service/);
  assert.match(bondRefreshTimer, /OnActiveSec=45s/);
  assert.match(bondRefreshTimer, /OnUnitActiveSec=1min/);
  assert.match(voteBackfillTimer, /OnActiveSec=15min/);
  assert.match(voteBackfillTimer, /OnUnitActiveSec=1h/);
  assert.match(sourceGuard, /production releases require a clean main commit matching origin\/main/);
  assert.match(sourceGuard, /check-runs\?per_page=100/);
  assert.match(deployScript, /git .*archive/s);
  assert.match(deployScript, /ARCHIVE_SHA256/);
  assert.match(
    deployScript,
    /tar --no-xattrs --no-mac-metadata[\s\S]*backend shared scripts ops/
  );
  assert.match(remoteDeployScript, /flock -n 9/);
  assert.match(remoteDeployScript, /atomic_point_current/);
  assert.match(remoteDeployScript, /Rolling back to/);
  assert.match(remoteDeployScript, /chmod 0640 "\$ENV_FILE"/);
  assert.match(remoteDeployScript, /npm ci --omit=dev/);
  assert.match(remoteDeployScript, /boonetools-db-migrate\.sh/);
  assert.match(remoteDeployScript, /local retry_delay_seconds=35/);
  assert.match(
    remoteDeployScript,
    /boonetools-pol-tracker\.service[\s\S]*continuing with its cached read model/
  );
  assert.match(remoteDeployScript, /local timer_state_wait_seconds=90/);
  assert.match(remoteDeployScript, /systemctl show "\$timer" --property=Triggers --value/);
  assert.match(remoteDeployScript, /target_state" == activating/);
  assert.match(remoteDeployScript, /still \$target_state after the settle window/);
  assert.match(remoteDeployScript, /next trigger will be scheduled after the target exits/);
  assert.match(remoteDeployScript, /refresh_status_models_after_long_primes/);
  assert.match(remoteDeployScript, /refresh_core_and_app_layer_models/);
  assert.match(
    remoteDeployScript,
    /prime_read_models\(\)[\s\S]*prime_read_model_unit "boonetools-rujira-reserve-payments\.service"[\s\S]*refresh_core_and_app_layer_models/
  );
  assert.match(
    remoteDeployScript,
    /prime_read_models[\s\S]*boonetools-wasm-arb-economics\.service[\s\S]*refresh_status_models_after_long_primes[\s\S]*boonetools-analytics-read-models\.service/
  );
  assert.match(remoteDeployScript, /has no future trigger/);
  assert.match(remoteDeployScript, /https:\/\/mail\.theaiguys\.ai\//);
  assert.doesNotMatch(remoteDeployScript, /systemctl reload caddy/);
  assert.doesNotMatch(remoteDeployScript, /Caddyfile\.boone\.tools/);
  assert.match(frontendDeployScript, /ARCHIVE_SHA256/);
  assert.match(
    frontendDeployScript,
    /tar --no-xattrs --no-mac-metadata -C "\$ROOT\/dist" -czf "\$ARCHIVE" \./
  );
  assert.match(remoteFrontendDeployScript, /flock -n 9/);
  assert.match(remoteFrontendDeployScript, /atomic_point_current/);
  assert.match(remoteFrontendDeployScript, /public asset does not match the activated release/);
  assert.match(remoteFrontendDeployScript, /frontend rollback did not verify successfully/);
  assert.match(perfSmoke, /allowStale: false/);
  assert.match(perfSmoke, /--allow-stale-endpoint/);
  assert.match(perfSmoke, /allowStaleEndpoints\.has\(endpoint\.name\)/);
  assert.match(remoteDeployScript, /--allow-stale-endpoint pol-tracker/);
  assert.match(perfSmoke, /stale response\(s\)/);
  assert.match(perfSmoke, /response content type was not JSON/);
});

test('every deploy-managed unit follows the atomic current release', async () => {
  const systemdDirectory = new URL('../../ops/systemd/', import.meta.url);
  const names = await readdir(systemdDirectory);
  const services = names.filter((name) => name.endsWith('.service'));
  const timers = names.filter((name) => name.endsWith('.timer'));

  for (const service of services) {
    const contents = await readFile(new URL(service, systemdDirectory), 'utf8');
    assert.doesNotMatch(contents, /\/opt\/boonetools-backend\/backend/);
    assert.doesNotMatch(contents, /\/opt\/boonetools-backend\/scripts/);
    assert.match(contents, /EnvironmentFile=\/opt\/boonetools-backend\/config\/backend\.env/);
  }

  for (const timer of timers) {
    const contents = await readFile(new URL(timer, systemdDirectory), 'utf8');
    assert.doesNotMatch(contents, /^OnBootSec=/m);
    assert.match(contents, /^(OnActiveSec|OnCalendar)=/m);
  }
});
