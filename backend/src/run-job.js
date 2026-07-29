import { closePool } from './db/pool.js';
import { runAnalyticsReadModels } from './jobs/analytics-read-models.js';
import { runAppLayerLiveStateScheduler } from './jobs/app-layer-live-state-scheduler.js';
import { runBondHistoryRefreshQueue } from './jobs/bond-history-refresh.js';
import { runNodeopScheduler } from './jobs/nodeop-scheduler.js';
import { runNodeVotesBackfill } from './jobs/node-votes-backfill.js';
import { runNodeVotesSummary } from './jobs/node-votes-summary.js';
import { runRapidSwapsMarketHistory } from './jobs/rapid-swaps-market-history.js';
import { runRapidSwapsScheduler } from './jobs/rapid-swaps-scheduler.js';
import { runRujiraBaseFeesScheduler } from './jobs/rujira-base-fees-scheduler.js';
import { runRujiraReservePaymentsScheduler } from './jobs/rujira-reserve-payments-scheduler.js';
import { runStatusDashboardScheduler } from './jobs/status-dashboard-scheduler.js';
import { runStatusLiveScheduler } from './jobs/status-live-scheduler.js';
import { runTcFeeDashBackfill } from './jobs/tc-fee-dash-backfill.js';
import { runTreasurySnapshot } from './jobs/treasury-snapshot.js';
import { runWasmArbEconomicsScheduler } from './jobs/wasm-arb-economics-scheduler.js';
import { runThorNodeCoreSnapshot } from './shared/thornode-core-snapshot.js';

const jobName = process.argv[2] || '';

const runners = {
  'analytics-read-models': runAnalyticsReadModels,
  'app-layer-live-state-scheduler': runAppLayerLiveStateScheduler,
  'bond-history-refresh': runBondHistoryRefreshQueue,
  'nodeop-scheduler': runNodeopScheduler,
  'node-votes-backfill': runNodeVotesBackfill,
  'node-votes-summary': runNodeVotesSummary,
  'rapid-swaps-market-history': runRapidSwapsMarketHistory,
  'rapid-swaps-scheduler': runRapidSwapsScheduler,
  'rujira-base-fees-scheduler': runRujiraBaseFeesScheduler,
  'rujira-reserve-payments-scheduler': runRujiraReservePaymentsScheduler,
  'status-dashboard-scheduler': runStatusDashboardScheduler,
  'status-live-scheduler': runStatusLiveScheduler,
  'tc-fee-dash-backfill': runTcFeeDashBackfill,
  'thornode-core-snapshot': runThorNodeCoreSnapshot,
  'treasury-snapshot': runTreasurySnapshot,
  'wasm-arb-economics-scheduler': runWasmArbEconomicsScheduler
};

if (!runners[jobName]) {
  console.error(`Unknown job: ${jobName}`);
  process.exit(1);
}

try {
  const result = await runners[jobName]();
  console.log(JSON.stringify(result, null, 2));
  await closePool();
  process.exit(0);
} catch (error) {
  console.error(error);
  await closePool().catch(() => {});
  process.exit(1);
}
