import { createRecordedJobRunner } from '../lib/recorded-job.js';
import { runWasmArbEconomicsIngestion } from '../shared/wasm-arb-economics-ingestion.js';

const LOCK_KEY = 'boonetools:wasm-arb-economics';
const JOB_NAME = 'wasm-arb-economics-scheduler';

export const runWasmArbEconomicsScheduler = createRecordedJobRunner({
  lockKey: LOCK_KEY,
  tableName: 'wasm_arb_economics_job_runs',
  jobName: JOB_NAME,
  run: runWasmArbEconomicsIngestion
});
