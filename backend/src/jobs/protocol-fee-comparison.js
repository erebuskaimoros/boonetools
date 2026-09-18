import { COMPARISON_MODEL_KEY, COMPARISON_REFRESH_MS, hasComparisonData, nextDay } from '../../../shared/protocol-fee-comparison/model.js';
import { withAdvisoryLock } from '../db/lock.js';
import { requestFromProviders } from '../lib/provider-client.js';
import { loadAcquisition, saveAcquisition } from '../shared/acquisition-cache.js';
import { providerLifecycleHooks } from '../shared/provider-cooldown.js';
import { publishReadModel } from '../shared/read-models.js';
import { collectComparison, emptyComparisonCache } from '../protocol-fee-comparison/collector.js';

const ORIGINS = new Set(['https://gateway.liquify.com', 'https://api.llama.fi', 'https://coins.llama.fi',
  'https://revenue.near.org', 'https://mainnet-archive.chainflip.io',
  'https://archival-rpc.mainnet.fastnear.com', 'https://transfers.main.fastnear.com']);
export function comparisonRequest(client, { transport = requestFromProviders } = {}) {
  let nearQueue = Promise.resolve(), lastNearRequest = 0;
  return (url, { method = 'GET', body, responseType = 'json' } = {}) => {
    const parsed = new URL(url);
    if (!ORIGINS.has(parsed.origin)) throw new Error('Comparison provider not allowlisted');
    const run = () => transport({ bases: [parsed.origin], path: `${parsed.pathname}${parsed.search}`, timeoutMs: 45000,
      responseType, allowHtml: parsed.origin === 'https://revenue.near.org' && responseType === 'text',
      request: { method, ...(body ? { body: JSON.stringify(body) } : {}) },
      headers: { Accept: responseType === 'text' ? 'text/html' : 'application/json', 'Content-Type': 'application/json', 'x-client-id': 'BooneTools-ProtocolComparison' },
      ...(client ? providerLifecycleHooks({ client, scope: 'protocol-fee-comparison' }) : {}) });
    if (!parsed.hostname.endsWith('.fastnear.com')) return run();
    // Public historical acquisition is resumable, not a burst against a free RPC.
    const pending = nearQueue.then(async () => {
      const delay = Math.max(0, 1200 - (Date.now() - lastNearRequest));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      lastNearRequest = Date.now();
      return run();
    });
    nearQueue = pending.catch(() => {});
    return pending;
  };
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
