import { withAdvisoryLock } from '../db/lock.js';
import { refreshVisitorSnapshots } from '../shared/visitor-snapshots.js';
import { refreshAffiliateQueue } from '../shared/dynamic-fee-affiliate-ingestion.js';
import { loadAcquisition } from '../shared/acquisition-cache.js';
import { advanceStableSwapBackfill } from '../shared/dynamic-fee-stable-swap-backfill.js';

// The timer fires about once a minute (1,440 runs/day). One page per run keeps
// the stable swap backfill at or below 1,440 bulk /actions pages per day, under
// its ~1,900/day share of the shared 5,000/day bulk budget; two would be 2,880.
export const STABLE_SWAP_BACKFILL_PAGES_PER_RUN = 1;

// A provider deferral or failure in this optional history lane is recorded on
// its state row and never fails the job, which serves visitors first.
async function runStableSwapBackfill(client, options) {
  try {
    const result = await (options.advanceStableSwapBackfill || advanceStableSwapBackfill)(client,
      { maxPages: STABLE_SWAP_BACKFILL_PAGES_PER_RUN });
    if (result.pages || result.error) {
      (options.log || console.log)(`Stable swap backfill: ${result.pages} pages, ${result.swaps} stable swaps, `
        + `${result.days_completed} days completed (${result.status}${result.error ? `: ${result.error}` : ''})`);
    }
    return result;
  } catch (error) {
    (options.log || console.log)(`Stable swap backfill failed: ${error?.message || error}`);
    return { status: 'error', pages: 0, days_completed: 0, swaps: 0, error: error?.message || String(error) };
  }
}

export async function runVisitorDataScheduler(options = {}) {
  return (options.lockRunner || withAdvisoryLock)('boonetools:visitor-data', async (client) => {
    const snapshots = await (options.refreshSnapshots || refreshVisitorSnapshots)(client, options);
    const affiliates = await (options.refreshAffiliates || refreshAffiliateQueue)(client, options);
    await client.query(`delete from source_observations where completed_at is null
      and expires_at < now() - interval '7 days'
      and not (namespace = 'visitor-snapshot:v1' and identity in ('vault', 'dynamic-fees'))`);
    const missing = [];
    for (const key of ['vault', 'dynamic-fees']) {
      const snapshot = await (options.loadSnapshot || loadAcquisition)(client, 'visitor-snapshot:v1', key, { allowStale: true });
      if (!snapshot) missing.push(key);
    }
    // Last, after the visitor-facing work above has committed.
    const stableSwaps = await runStableSwapBackfill(client, options);
    if (missing.length) throw new Error(`Shared visitor snapshot warmup incomplete: ${missing.join(', ')}`);
    return { ok: snapshots.errors.length === 0 && affiliates.errors.length === 0, snapshots, affiliates, stableSwaps };
  });
}
