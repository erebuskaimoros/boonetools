import { COMPARISON_MODEL_KEY, COMPARISON_REFRESH_MS, hasComparisonData, nextDay } from '../../../shared/protocol-fee-comparison/model.js';
import { withAdvisoryLock } from '../db/lock.js';
import { requestFromProviders } from '../lib/provider-client.js';
import { loadAcquisition, saveAcquisition } from '../shared/acquisition-cache.js';
import { providerLifecycleHooks } from '../shared/provider-cooldown.js';
import { publishReadModel } from '../shared/read-models.js';
import { buildComparisonPayload, collectComparison, emptyComparisonCache } from '../protocol-fee-comparison/collector.js';
import { createComparisonRequest } from '../../../shared/protocol-fee-comparison/request.js';

export function comparisonRequest(client, { transport = requestFromProviders } = {}) {
  return createComparisonRequest({ transport,
    hooks: client ? providerLifecycleHooks({ client, scope: 'protocol-fee-comparison' }) : {} });
}

export async function runProtocolFeeComparison(options = {}) {
  return (options.lockRunner || withAdvisoryLock)('boonetools:protocol-fee-comparison', async (client) => {
    const now = options.now ?? Date.now();
    const cached = await loadAcquisition(client, COMPARISON_MODEL_KEY, 'collector', { allowStale: true });
    const cache = cached?.payload || emptyComparisonCache();
    const checkpointPayload = (current, asOf = new Date(now).toISOString()) => ({
      ...buildComparisonPayload(current, { now, errors: ['Source acquisition is in progress; displaying verified checkpoints.'] }),
      asOf, stale: true, acquisitionInProgress: true
    });
    const publish = async (payload) => {
      if (hasComparisonData(payload)) await publishReadModel(COMPARISON_MODEL_KEY, payload, {
        client, ttlMs: COMPARISON_REFRESH_MS * 2, sourceUpdatedAt: `${nextDay(payload.throughDay)}T00:00:00Z` });
    };
    // A previous process can have saved months of history before being killed.
    // Expose that durable work before making any new provider requests, without
    // representing recovery as a successfully completed source refresh.
    await publish(checkpointPayload(cache, cached?.observedAt || new Date(now).toISOString()));
    const result = await (options.collector || collectComparison)({ cache, now,
      maxRunMs: options.maxRunMs, clock: options.clock,
      request: comparisonRequest(client),
      log: (message) => console.log(JSON.stringify({ type: 'protocol_fee_comparison', message })),
      save: async (current, payload) => {
        await saveAcquisition(client, { namespace: COMPARISON_MODEL_KEY, identity: 'collector',
          payload: current, source: 'midgard+llama+fastnear+chainflip-archive',
          observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + COMPARISON_REFRESH_MS).toISOString() });
        await publish(payload || checkpointPayload(current));
      } });
    await publish(result.payload);
    // A bounded, resumable run is not a provider outage. Actual source errors
    // retain the existing failed-job signal, after publishing useful progress.
    const sourceErrors = result.sourceErrors ?? result.payload.errors;
    if (sourceErrors.length) throw new Error(sourceErrors.join('; '));
    if (!hasComparisonData(result.payload)) throw new Error('Comparison has no aligned observations yet');
    return { months: result.payload.months.length, throughDay: result.payload.throughDay, deferred: Boolean(result.deferred) };
  });
}
