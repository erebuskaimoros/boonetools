import { createRecordedJobRunner } from '../lib/recorded-job.js';
import { runRujiraReservePaymentsIngestion } from '../shared/rujira-reserve-payments.js';

const LOCK_KEY = 'boonetools:rujira-reserve-payments';
const JOB_NAME = 'rujira-reserve-payments-scheduler';

export const runRujiraReservePaymentsScheduler = createRecordedJobRunner({
  lockKey: LOCK_KEY,
  tableName: 'rujira_reserve_payment_job_runs',
  jobName: JOB_NAME,
  run: runRujiraReservePaymentsIngestion
});
