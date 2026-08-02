import { createRecordedJobRunner } from '../lib/recorded-job.js';
import { runWasmArbFeeIngestion } from '../shared/wasm-arb-economics-ingestion.js';

export const runWasmArbEconomicsFees = createRecordedJobRunner({
  lockKey: 'boonetools:wasm-arb-economics:fees',
  tableName: 'wasm_arb_economics_job_runs',
  jobName: 'wasm-arb-economics-fees',
  run: runWasmArbFeeIngestion
});
