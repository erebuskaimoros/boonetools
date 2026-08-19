import { closePool } from './db/pool.js';
import { createJobCompletionLog, createJobFailureLog } from './lib/job-log.js';
import { runAnalyticsReadModels } from './jobs/analytics-read-models.js';
import { runAppLayerLiveStateScheduler } from './jobs/app-layer-live-state-scheduler.js';
import { runBondHistoryRefreshQueue } from './jobs/bond-history-refresh.js';
import { runNodeopScheduler } from './jobs/nodeop-scheduler.js';
import { runNodeVotesBackfill } from './jobs/node-votes-backfill.js';
import { runNodeVotesSummary } from './jobs/node-votes-summary.js';
import { runPoolDislocationBackfill } from './jobs/pool-dislocation-backfill.js';
import { runPoolDislocationRepair } from './jobs/pool-dislocation-repair.js';
import { runPoolDislocationScheduler } from './jobs/pool-dislocation-scheduler.js';
import { runPolTrackerBackfill, runPolTrackerScheduler } from './jobs/pol-tracker.js';
import { runRapidSwapsMarketHistory } from './jobs/rapid-swaps-market-history.js';
import { runRapidSwapsScheduler } from './jobs/rapid-swaps-scheduler.js';
import { runRujiraBaseFeesScheduler } from './jobs/rujira-base-fees-scheduler.js';
import { runRujiraReservePaymentsScheduler } from './jobs/rujira-reserve-payments-scheduler.js';
import { runStatusDashboardScheduler } from './jobs/status-dashboard-scheduler.js';
import { runStatusLiveScheduler } from './jobs/status-live-scheduler.js';
import { runTcFeeDashBackfill } from './jobs/tc-fee-dash-backfill.js';
import { runTreasurySnapshot } from './jobs/treasury-snapshot.js';
import { runWasmArbEconomicsFees } from './jobs/wasm-arb-economics-fees.js';
import { runWasmArbEconomicsOracle } from './jobs/wasm-arb-economics-oracle.js';
import { runWasmArbEconomicsScheduler } from './jobs/wasm-arb-economics-scheduler.js';
import { runThorNodeCoreSnapshot } from './shared/thornode-core-snapshot.js';

const jobName = process.argv[2] || '';
const startedAt = Date.now();

const runners = {
  'analytics-read-models': runAnalyticsReadModels,
  'app-layer-live-state-scheduler': runAppLayerLiveStateScheduler,
  'bond-history-refresh': runBondHistoryRefreshQueue,
  'nodeop-scheduler': runNodeopScheduler,
  'node-votes-backfill': runNodeVotesBackfill,
  'node-votes-summary': runNodeVotesSummary,
  'pool-dislocation-backfill': runPoolDislocationBackfill,
  'pool-dislocation-repair': runPoolDislocationRepair,
  'pool-dislocation-scheduler': runPoolDislocationScheduler,
  'pol-tracker-backfill': runPolTrackerBackfill,
  'pol-tracker-scheduler': runPolTrackerScheduler,
  'rapid-swaps-market-history': runRapidSwapsMarketHistory,
  'rapid-swaps-scheduler': runRapidSwapsScheduler,
  'rujira-base-fees-scheduler': runRujiraBaseFeesScheduler,
  'rujira-reserve-payments-scheduler': runRujiraReservePaymentsScheduler,
  'status-dashboard-scheduler': runStatusDashboardScheduler,
  'status-live-scheduler': runStatusLiveScheduler,
  'tc-fee-dash-backfill': runTcFeeDashBackfill,
  'thornode-core-snapshot': runThorNodeCoreSnapshot,
  'treasury-snapshot': runTreasurySnapshot,
  'wasm-arb-economics-fees': runWasmArbEconomicsFees,
  'wasm-arb-economics-oracle': runWasmArbEconomicsOracle,
  'wasm-arb-economics-scheduler': runWasmArbEconomicsScheduler
};

if (!runners[jobName]) {
  console.error(`Unknown job: ${jobName}`);
  process.exit(1);
}

try {
  await runners[jobName]();
  console.log(createJobCompletionLog(jobName, Date.now() - startedAt));
  await closePool();
  process.exit(0);
} catch (error) {
  console.error(createJobFailureLog(jobName, error, Date.now() - startedAt));
  await closePool().catch(() => {});
  process.exit(1);
}
