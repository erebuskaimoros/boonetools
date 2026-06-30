import { withAdvisoryLock } from '../db/lock.js';
import { runRujiraBaseFeesIngestion } from '../shared/rujira-base-fees.js';

const LOCK_KEY = 'boonetools:rujira-base-fees';
const JOB_NAME = 'rujira-base-fees-scheduler';

async function insertJobRun(client) {
  const { rows } = await client.query(
    `insert into rujira_base_fee_job_runs (job_name, started_at, status, stats_json)
     values ($1, now(), 'running', '{}'::jsonb)
     returning id`,
    [JOB_NAME]
  );
  return String(rows[0].id);
}

async function completeJobRun(client, jobId, status, stats, error = '') {
  await client.query(
    `update rujira_base_fee_job_runs
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

export async function runRujiraBaseFeesScheduler() {
  return withAdvisoryLock(LOCK_KEY, async (client) => {
    const jobId = await insertJobRun(client);
    try {
      const stats = await runRujiraBaseFeesIngestion(client);
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
