function safeTableName(tableName) {
  const normalized = String(tableName || '');
  if (!/^[a-z][a-z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid recorded-job table: ${tableName}`);
  }
  return normalized;
}

function statsObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function errorMessage(error) {
  return String(error?.message || error || 'Recorded job failed');
}

export async function insertRecordedJobRun(client, options = {}) {
  const tableName = safeTableName(options.tableName);
  const startedAt = options.startedAt || new Date().toISOString();
  const { rows } = await client.query(
    `insert into ${tableName} (job_name, started_at, status, stats_json)
     values ($1, $2, 'running', $3)
     returning id`,
    [options.jobName, startedAt, statsObject(options.stats)]
  );
  return String(rows[0].id);
}

export async function completeRecordedJobRun(client, options = {}) {
  const tableName = safeTableName(options.tableName);
  await client.query(
    `update ${tableName}
     set finished_at = $2,
         status = $3,
         error = $4,
         stats_json = $5
     where id = $1`,
    [
      options.jobId,
      options.finishedAt || new Date().toISOString(),
      options.status,
      options.error || null,
      statsObject(options.stats)
    ]
  );
}

export async function runRecordedJob(client, options = {}) {
  const jobId = await insertRecordedJobRun(client, options);

  try {
    const stats = statsObject(await options.run(client));
    await completeRecordedJobRun(client, {
      ...options,
      jobId,
      status: 'success',
      stats
    });
    return {
      ok: true,
      job_id: jobId,
      ...stats
    };
  } catch (error) {
    const message = errorMessage(error);
    await completeRecordedJobRun(client, {
      ...options,
      jobId,
      status: 'error',
      error: message,
      stats: { error: message }
    }).catch(() => {});
    throw error;
  }
}

export function createRecordedJobRunner(options = {}) {
  const lockRunner = options.lockRunner || (async (lockKey, callback) => {
    const { withAdvisoryLock } = await import('../db/lock.js');
    return withAdvisoryLock(lockKey, callback);
  });
  return () => lockRunner(options.lockKey, (client) => runRecordedJob(client, options));
}
