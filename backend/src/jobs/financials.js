import { setTimeout as delay } from 'node:timers/promises';
import { FINANCIALS_RANGES } from '../../../shared/financials/model.js';
import { withAdvisoryLock } from '../db/lock.js';
import { requestFromProviders } from '../lib/provider-client.js';
import { providerLifecycleHooks } from '../shared/provider-cooldown.js';
import { createFinancialsService } from '../shared/financials-service.js';
import { FINANCIALS_MIDGARD, FINANCIALS_RPC } from '../shared/financials-history.js';
import { FINANCIALS_MODEL_TTL_MS, financialsModelKey } from '../shared/financials-read-model.js';
import { createReadModelEtag, publishReadModel } from '../shared/read-models.js';

export function createFinancialsProviderRequest(client, { transport = requestFromProviders } = {}) {
  return (url, { lane = 'history' } = {}) => {
    const base = [FINANCIALS_MIDGARD, FINANCIALS_RPC].find((candidate) => url.startsWith(`${candidate}/`));
    if (!base) throw new Error('Financials provider is not allowlisted');
    return transport({ bases: [base], path: url.slice(base.length), timeoutMs: 60_000,
      headers: { Accept: 'application/json', 'x-client-id': 'BooneTools-Financials' },
      ...providerLifecycleHooks({ client, scope: `financials-${lane}` })
    });
  };
}

export async function publishFinancialsSnapshots(service, client, options = {}) {
  const published = options.published || new Map();
  const now = options.now?.() ?? Date.now();
  const results = [];
  for (const { id: range } of FINANCIALS_RANGES) {
    const payload = await service.getSnapshot(range);
    if (!payload.points.some((point) => point.volumeRune !== null || point.incomeRune !== null)) continue;
    const key = financialsModelKey(range);
    const etag = createReadModelEtag(payload);
    const previous = published.get(key);
    if (previous?.etag === etag && now - previous.at < FINANCIALS_MODEL_TTL_MS / 2) continue;
    await (options.publish || publishReadModel)(key, payload, {
      client, schemaVersion: 1, ttlMs: FINANCIALS_MODEL_TTL_MS,
      generatedAt: new Date(now).toISOString(), sourceUpdatedAt: payload.live?.through || payload.asOf,
      metadata: { collector: 'financials', interval_seconds: 300 }
    });
    published.set(key, { etag, at: now });
    results.push(key);
  }
  return results;
}

// Independent acquisition and publication loops keep the live read model
// moving while slow archive calls or first-run history fills are in flight.
export async function runFinancialsCollector(options = {}) {
  return (options.lockRunner || withAdvisoryLock)('boonetools:financials', async (client) => {
    const controller = new AbortController();
    const signal = controller.signal;
    const service = options.service || createFinancialsService({
      cacheDir: options.cacheDir || process.env.FINANCIALS_CACHE_DIR || '/var/lib/boonetools-financials',
      requestJson: createFinancialsProviderRequest(client)
    });
    const published = new Map();
    const log = options.log || ((message) => console.error(JSON.stringify({ type: 'financials', message })));
    let stopping;
    const stop = () => {
      controller.abort();
      stopping ||= service.stop();
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    async function loop(interval, operation) {
      while (!signal.aborted) {
        try { await operation(); } catch (error) { if (!signal.aborted) log(error.message); }
        await delay(interval, undefined, { signal }).catch((error) => { if (error.name !== 'AbortError') throw error; });
      }
    }
    try {
      await Promise.all([
        (async () => {
          if (!signal.aborted) await service.refreshHistory('30d');
          await loop(5 * 60_000, () => service.refreshHistory('all'));
        })(),
        loop(30_000, () => service.refreshLive()),
        loop(5000, () => publishFinancialsSnapshots(service, client, { published, publish: options.publish }))
      ]);
    } finally {
      stop();
      options.signal?.removeEventListener('abort', stop);
      await stopping;
    }
  });
}
