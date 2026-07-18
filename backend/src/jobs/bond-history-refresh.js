import {
  claimBondHistoryRefresh,
  completeBondHistoryRefresh,
  failBondHistoryRefresh
} from '../shared/bond-history-refresh-queue.js';

const DEFAULT_BATCH_SIZE = 4;

async function defaultWithAdvisoryLock(lockKey, callback) {
  const { withAdvisoryLock } = await import('../db/lock.js');
  return withAdvisoryLock(lockKey, callback);
}

async function defaultHandleBondHistory(request, url) {
  const { handleBondHistory } = await import('../handlers/bond-history.js');
  return handleBondHistory(request, url);
}

function buildRefreshUrl(job) {
  const url = new URL('http://127.0.0.1/bond-history');
  url.searchParams.set('bond_address', job.bond_address);
  url.searchParams.set('refresh', 'sync');
  if (job.scope === 'historical') {
    url.searchParams.set('include_historical', 'true');
  }
  if (job.include_bond_txs) {
    url.searchParams.set('include_bond_txs', 'true');
  }
  return url;
}

export async function runBondHistoryRefreshQueue(options = {}) {
  const batchSize = Math.max(1, Math.min(25, Number(options.batchSize) || DEFAULT_BATCH_SIZE));
  const claim = options.claim || claimBondHistoryRefresh;
  const complete = options.complete || completeBondHistoryRefresh;
  const fail = options.fail || failBondHistoryRefresh;
  const runWithLock = options.withAdvisoryLock || defaultWithAdvisoryLock;
  const handler = options.handleBondHistory || defaultHandleBondHistory;
  const stats = {
    claimed: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    requeued: 0,
    jobs: []
  };

  for (let index = 0; index < batchSize; index += 1) {
    const job = await claim();
    if (!job) break;
    stats.claimed += 1;

    try {
      const lockKey = `boonetools:bond-history:${job.scope}:${job.bond_address}`;
      const outcome = await runWithLock(lockKey, async () => {
        const response = await handler({ headers: {} }, buildRefreshUrl(job));
        if (Number(response?.status || 500) >= 400) {
          throw new Error(response?.body?.error || `Bond history refresh returned ${response?.status || 500}`);
        }
        if (response?.body?.stale || response?.body?.partial || response?.body?.warning) {
          throw new Error(response.body.warning || 'Bond history refresh returned incomplete data');
        }
        return response;
      });

      if (outcome?.skipped) {
        stats.skipped += 1;
        const retry = await fail(job, new Error('Refresh lock is already held'));
        stats.jobs.push(retry);
        continue;
      }

      const completed = await complete(job, {
        status: outcome?.status || 200,
        total: Number(outcome?.body?.total || 0),
        fetched: Number(outcome?.body?.fetched || 0)
      });
      if (completed.status === 'completed') {
        stats.completed += 1;
      } else {
        stats.requeued += 1;
      }
      stats.jobs.push(completed);
    } catch (error) {
      stats.failed += 1;
      stats.jobs.push(await fail(job, error));
    }
  }

  return {
    ok: stats.failed === 0,
    ...stats
  };
}
