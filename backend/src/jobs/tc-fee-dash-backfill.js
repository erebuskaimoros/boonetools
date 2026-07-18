import { config } from '../lib/config.js';
import { createRecordedJobRunner } from '../lib/recorded-job.js';
import { sleep } from '../lib/utils.js';
import { runTcFeeDashDailyBackfill } from '../shared/tc-fee-dash-ingestion.js';

const LOCK_KEY = 'boonetools:tc-fee-dash';
const JOB_NAME = 'tc-fee-dash-backfill';

const runSingleTcFeeDashBackfill = createRecordedJobRunner({
  lockKey: LOCK_KEY,
  tableName: 'tc_fee_dash_job_runs',
  jobName: JOB_NAME,
  run: runTcFeeDashDailyBackfill
});

function isTerminalResult(result) {
  return result?.complete === true
    || result?.reason === 'complete'
    || result?.reason === 'missing_dune_api_key'
    || result?.reason === 'missing_dune_tc_fee_query_id'
    || result?.reason === 'missing_cmc_api_key';
}

function getRateLimitDelayMs(result) {
  const untilMs = Date.parse(String(result?.rate_limited_until || ''));
  if (Number.isFinite(untilMs) && untilMs > Date.now()) {
    return untilMs - Date.now();
  }
  return config.tcFeeDashRateLimitCooldownMs;
}

function summarizeBatches(results) {
  const last = results.at(-1) || {};
  return {
    ok: true,
    batches: results.length,
    first_job_id: results[0]?.job_id || null,
    last_job_id: last.job_id || null,
    ...last,
    batch_results: results
  };
}

export async function runTcFeeDashBackfill() {
  const results = [];

  while (true) {
    const result = await runSingleTcFeeDashBackfill();
    results.push(result);

    if (isTerminalResult(result)) {
      return summarizeBatches(results);
    }

    if (result?.reason === 'rate_limited') {
      await sleep(Math.max(1000, getRateLimitDelayMs(result)));
      continue;
    }

    if (result?.skipped) {
      return summarizeBatches(results);
    }
  }
}
