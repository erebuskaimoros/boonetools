import { createRecordedJobRunner } from '../lib/recorded-job.js';
import { runRujiraBaseFeesIngestion } from '../shared/rujira-base-fees.js';

const LOCK_KEY = 'boonetools:rujira-base-fees';
const JOB_NAME = 'rujira-base-fees-scheduler';

export const runRujiraBaseFeesScheduler = createRecordedJobRunner({
  lockKey: LOCK_KEY,
  tableName: 'rujira_base_fee_job_runs',
  jobName: JOB_NAME,
  run: runRujiraBaseFeesIngestion
});
