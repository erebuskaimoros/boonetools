import { withAdvisoryLock } from '../db/lock.js';
import { refreshVisitorSnapshots } from '../shared/visitor-snapshots.js';
import { refreshAffiliateQueue } from '../shared/dynamic-fee-affiliate-ingestion.js';
import { loadAcquisition } from '../shared/acquisition-cache.js';

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
    if (missing.length) throw new Error(`Shared visitor snapshot warmup incomplete: ${missing.join(', ')}`);
    return { ok: snapshots.errors.length === 0 && affiliates.errors.length === 0, snapshots, affiliates };
  });
}
