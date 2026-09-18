import { COMPARISON_MODEL_KEY, COMPARISON_REFRESH_MS, hasComparisonData, nextDay } from '../../../shared/protocol-fee-comparison/model.js';
import { withAdvisoryLock } from '../db/lock.js';
import { requestFromProviders } from '../lib/provider-client.js';
import { loadAcquisition, saveAcquisition } from '../shared/acquisition-cache.js';
import { providerLifecycleHooks } from '../shared/provider-cooldown.js';
import { publishReadModel } from '../shared/read-models.js';
import { collectComparison, emptyComparisonCache } from '../protocol-fee-comparison/collector.js';
import { createComparisonRequest } from '../../../shared/protocol-fee-comparison/request.js';

export function comparisonRequest(client, { transport = requestFromProviders } = {}) {
  return createComparisonRequest({ transport,
    hooks: client ? providerLifecycleHooks({ client, scope: 'protocol-fee-comparison' }) : {} });
}

export async function runProtocolFeeComparison(options = {}) {
  return (options.lockRunner || withAdvisoryLock)('boonetools:protocol-fee-comparison', async (client) => {
    const cached = await loadAcquisition(client, COMPARISON_MODEL_KEY, 'collector', { allowStale: true });
    const result = await collectComparison({ cache: cached?.payload || emptyComparisonCache(),
      request: comparisonRequest(client),
      log: (message) => console.log(JSON.stringify({ type: 'protocol_fee_comparison', message })),
      save: (cache) => saveAcquisition(client, { namespace: COMPARISON_MODEL_KEY, identity: 'collector',
        payload: cache, source: 'midgard+llama+fastnear+chainflip-archive',
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + COMPARISON_REFRESH_MS).toISOString() }) });
    if (hasComparisonData(result.payload)) await publishReadModel(COMPARISON_MODEL_KEY, result.payload, {
      client, ttlMs: COMPARISON_REFRESH_MS * 2, sourceUpdatedAt: `${nextDay(result.payload.throughDay)}T00:00:00Z` });
    if (result.payload.errors.length) throw new Error(result.payload.errors.join('; '));
    if (!hasComparisonData(result.payload)) throw new Error('Comparison has no aligned observations yet');
    return { months: result.payload.months.length, throughDay: result.payload.throughDay };
  });
}
