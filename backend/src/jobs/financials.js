import { setTimeout as delay } from 'node:timers/promises';
import { FINANCIALS_RANGES } from '../../../shared/financials/model.js';
import { withAdvisoryLock } from '../db/lock.js';
import { requestFromProviders } from '../lib/provider-client.js';
import { createBackendProviderServices } from '../lib/provider-services.js';
import { config } from '../lib/config.js';
import { providerLifecycleHooks } from '../shared/provider-cooldown.js';
import { createFinancialsService } from '../shared/financials-service.js';
import { FINANCIALS_MODEL_TTL_MS, financialsModelKey } from '../shared/financials-read-model.js';
import { createReadModelEtag, publishReadModel } from '../shared/read-models.js';
import { readFinancialRewardAccountingDays, repairFinancialRewardBlocks } from '../shared/financials-reward-source.js';
import { repairFinancialReserveEmissions } from '../shared/financials-reserve-service.js';
import { hasThorchainProviderPair } from '../../../shared/thorchain-provider-pool.js';
import { refreshFinancialDayQueue } from '../shared/financials-day-detail.js';
import { verifyFinancialSwapCandidates } from '../shared/financials-swap-candidates.js';
import { acquisitionMetrics } from '../lib/acquisition-metrics.js';
import { createFinancialsHourlyService } from '../shared/financials-hourly.js';
import { FINANCIALS_HOURLY_MODEL_KEY } from '../../../shared/financials/hourly.js';

// Liquify's block-results archive currently starts on October 6. Begin at the
// next complete UTC day, including the full first REVSHARE day (October 7).
// Older days stay unavailable; a signed Midgard residual is not a fallback.
const REWARD_HISTORY_FROM = Date.parse('2026-10-07T00:00:00Z') / 1000;

export function createFinancialsProviderRequest(client, { transport = requestFromProviders, midgardBases = config.midgardUrls } = {}) {
  const request = createBackendProviderServices({ transport, services: { midgard: midgardBases } });
  return (path, { service = 'midgard', lane = 'history', midgardBudgetClass, signal } = {}) => {
    if (!['midgard', 'rpc'].includes(service)) throw new Error('Financials provider is not allowlisted');
    return request(service, path, { timeoutMs: 60_000, request: { signal },
      // Preserve the existing 650ms start-rate limit separately on each RPC
      // provider, instead of serializing both behind the Midgard queue.
      providerMinIntervalMs: service === 'rpc' ? 650 : 0,
      ...(midgardBudgetClass ? { midgardBudgetClass } : {}),
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

export async function publishFinancialHourlySnapshot(service, client, options = {}) {
  const payload = await service.getSnapshot('30d');
  if (!payload.points.some(point => point.volumeRune !== null || point.incomeRune !== null)) return;
  const now = options.now?.() ?? Date.now(), etag = createReadModelEtag(payload);
  const previous = options.published?.get(FINANCIALS_HOURLY_MODEL_KEY);
  if (previous?.etag === etag && now - previous.at < FINANCIALS_MODEL_TTL_MS / 2) return;
  await (options.publish || publishReadModel)(FINANCIALS_HOURLY_MODEL_KEY, payload, {
    client, schemaVersion: 1, ttlMs: FINANCIALS_MODEL_TTL_MS, generatedAt: new Date(now).toISOString(),
    sourceUpdatedAt: payload.live?.through || payload.asOf, metadata: { collector: 'financials', interval_seconds: 3600 }
  });
  options.published?.set(FINANCIALS_HOURLY_MODEL_KEY, { etag, at: now });
}

// Independent acquisition and publication loops keep the live read model
// moving while slow archive calls or first-run history fills are in flight.
export async function runFinancialsCollector(options = {}) {
  return (options.lockRunner || withAdvisoryLock)('boonetools:financials', async (client) => {
    const controller = new AbortController();
    const signal = controller.signal;
    const service = options.service || createFinancialsService({
      cacheDir: options.cacheDir || process.env.FINANCIALS_CACHE_DIR || '/var/lib/boonetools-financials',
      requestJson: createFinancialsProviderRequest(client),
      rpcConcurrency: config.thorchainProviderBalancingEnabled && hasThorchainProviderPair(config.rpcRestUrls) ? 6 : 3,
      readRewardAccounting: window => readFinancialRewardAccountingDays(client, window)
    });
    const published = new Map();
    const hourly = options.hourlyService || (!options.service ? createFinancialsHourlyService({
      cacheDir: options.cacheDir || process.env.FINANCIALS_CACHE_DIR || '/var/lib/boonetools-financials',
      requestJson: createFinancialsProviderRequest(client)
    }) : null);
    const log = options.log || ((message) => console.error(JSON.stringify({ type: 'financials', message })));
    const dayRequest = route => createFinancialsProviderRequest(client)(route,
      { lane: 'day-details', midgardBudgetClass: 'bulk', signal });
    const verifySwaps = options.verifySwapCandidates || (!options.service && verifyFinancialSwapCandidates);
    let stopping;
    const stop = () => {
      controller.abort();
      stopping ||= Promise.all([service.stop(), hourly?.stop()]);
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
        loop(30_000, async () => { await service.refreshLive(); await service.refreshRewardAccounting?.(); }),
        ...(hourly ? [loop(60_000, () => hourly.refresh())] : []),
        ...(options.service && !options.refreshDayDetails ? [] : [loop(5000, () =>
          (options.refreshDayDetails || refreshFinancialDayQueue)(client, { signal,
            getJson: dayRequest }))]),
        // Fee-ranked stream candidates share the day-detail lane and bulk
        // budget. Legacy input-value snapshots are no longer fee-fill work.
        ...(!verifySwaps ? [] : [loop(30_000, () =>
          verifySwaps(client, { signal, getJson: dayRequest, poolScopes: true }))]),
        loop(60_000, () => {
          const acquisition = acquisitionMetrics({ reset: true });
          if (acquisition) log({ type: 'acquisition_metrics', window_seconds: 60, acquisition });
        }),
        // Steady-state capture is provider-free. A separate bounded lane
        // repairs startup history and websocket gaps without blocking live
        // publication or sharing the historical-bond acquisition lane.
        ...(options.service && !options.repairRewards ? [] : [loop(5000, async () => {
          const result = await (options.repairRewards || repairFinancialRewardBlocks)(client, {
            signal, from: REWARD_HISTORY_FROM, limit: 2000, budgetMs: 20_000
          });
          if (result.repaired) log(`Reward archive: captured ${result.repaired} blocks (${result.reserveObserved ?? 0} Reserve observations)`);
          await service.refreshRewardAccounting?.();
        })]),
        ...(options.service && !options.repairEmissions ? [] : [loop(5000, async () => {
          const result = await (options.repairEmissions || repairFinancialReserveEmissions)(client, {
            signal, from: REWARD_HISTORY_FROM, limit: 5000,
            getJson: (path, options) => createFinancialsProviderRequest(client)(path, { ...options, lane: 'reserve-emissions' })
          });
          if (result.reconstructed) log(`Reserve emissions: verified ${result.reconstructed} blocks`);
          if (result.deferred) log(`Reserve emissions: deferred ${result.deferred} blocks: ${result.errors.join('; ')}`);
          await service.refreshRewardAccounting?.();
        })]),
        loop(5000, async () => {
          await publishFinancialsSnapshots(service, client, { published, publish: options.publish });
          if (hourly) await publishFinancialHourlySnapshot(hourly, client, { published, publish: options.publish });
        })
      ]);
    } finally {
      stop();
      options.signal?.removeEventListener('abort', stop);
      await stopping;
    }
  });
}
