import { closePool } from './db/pool.js';
import { runNodeopScheduler } from './jobs/nodeop-scheduler.js';
import { runRapidSwapsScheduler } from './jobs/rapid-swaps-scheduler.js';

const jobName = process.argv[2] || '';

const runners = {
  'nodeop-scheduler': runNodeopScheduler,
  'rapid-swaps-scheduler': runRapidSwapsScheduler
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
