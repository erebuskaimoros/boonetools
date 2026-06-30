import { withAdvisoryLock } from '../db/lock.js';
import { config } from '../lib/config.js';
import { sleep } from '../lib/utils.js';
import { runTcFeeDashDailyBackfill } from '../shared/tc-fee-dash-ingestion.js';

const LOCK_KEY = 'boonetools:tc-fee-dash';
const JOB_NAME = 'tc-fee-dash-backfill';

async function insertJobRun(client) {
  const { rows } = await client.query(
    `insert into tc_fee_dash_job_runs (job_name, started_at, status, stats_json)
     values ($1, now(), 'running', '{}'::jsonb)
     returning id`,
    [JOB_NAME]
  );
  return String(rows[0].id);
}

async function completeJobRun(client, jobId, status, stats, error = '') {
  await client.query(
    `update tc_fee_dash_job_runs
     set finished_at = now(),
         status = $2,
         error = $3,
         stats_json = $4
     where id = $1`,
    [
      jobId,
      status,
      error || null,
      stats || {}
    ]
  );
}

async function runSingleTcFeeDashBackfill() {
  return withAdvisoryLock(LOCK_KEY, async (client) => {
    const jobId = await insertJobRun(client);
    try {
      const stats = await runTcFeeDashDailyBackfill(client);
      await completeJobRun(client, jobId, 'success', stats);
      return {
        ok: true,
        job_id: jobId,
        ...stats
      };
    } catch (error) {
      const stats = {
        error: error.message || String(error)
      };
      await completeJobRun(client, jobId, 'error', stats, stats.error);
      throw error;
    }
  });
}

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
