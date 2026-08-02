import { createRecordedJobRunner } from '../lib/recorded-job.js';
import { runWasmArbOracleIngestion } from '../shared/wasm-arb-economics-ingestion.js';

export const runWasmArbEconomicsOracle = createRecordedJobRunner({
  lockKey: 'boonetools:wasm-arb-economics:oracle',
  tableName: 'wasm_arb_economics_job_runs',
  jobName: 'wasm-arb-economics-oracle',
  run: runWasmArbOracleIngestion
});
