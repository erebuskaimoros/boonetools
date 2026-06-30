import { closePool } from './db/pool.js';
import { runAppLayerLiveStateScheduler } from './jobs/app-layer-live-state-scheduler.js';
import { runNodeopScheduler } from './jobs/nodeop-scheduler.js';
import { runNodeVotesBackfill } from './jobs/node-votes-backfill.js';
import { runRapidSwapsScheduler } from './jobs/rapid-swaps-scheduler.js';
import { runRujiraBaseFeesScheduler } from './jobs/rujira-base-fees-scheduler.js';
import { runRujiraReservePaymentsScheduler } from './jobs/rujira-reserve-payments-scheduler.js';
import { runTcFeeDashBackfill } from './jobs/tc-fee-dash-backfill.js';

const jobName = process.argv[2] || '';

const runners = {
  'app-layer-live-state-scheduler': runAppLayerLiveStateScheduler,
  'nodeop-scheduler': runNodeopScheduler,
  'node-votes-backfill': runNodeVotesBackfill,
  'rapid-swaps-scheduler': runRapidSwapsScheduler,
  'rujira-base-fees-scheduler': runRujiraBaseFeesScheduler,
  'rujira-reserve-payments-scheduler': runRujiraReservePaymentsScheduler,
  'tc-fee-dash-backfill': runTcFeeDashBackfill
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
