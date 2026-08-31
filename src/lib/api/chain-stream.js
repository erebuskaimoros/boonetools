import {
  booneToolsApiConfig,
  buildBooneToolsApiUrl
} from './boonetools.js';

export function parseChainHeadEvent(value) {
  try {
    const payload = typeof value === 'string' ? JSON.parse(value) : value;
    const height = Number(payload?.height);
    const time = String(payload?.time || '');
    if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(Date.parse(time))) return null;
    const intervalMs = Number(payload?.interval_ms);
    const incomeBurn = String(payload?.income_burn_e8 ?? '').trim();
    const polReserveReward = String(payload?.pol_reserve_reward_e8 ?? '').trim();
    const polReserveDeployments = (Array.isArray(payload?.pol_reserve_deployments)
      ? payload.pol_reserve_deployments
      : [])
      .map((deployment) => {
        const asset = String(deployment?.asset || deployment?.pool || '').trim();
        const runeE8 = String(deployment?.rune_e8 ?? deployment?.rune_amount_e8 ?? '').trim();
        const unitsE8 = String(deployment?.units_e8 ?? deployment?.minted_units_e8 ?? '').trim();
        if (!asset || !/^\d+$/.test(runeE8)) return null;
        return {
          asset,
          rune_e8: runeE8,
          units_e8: /^\d+$/.test(unitsE8) ? unitsE8 : null
        };
      })
      .filter(Boolean);
    return {
      height: Math.trunc(height),
      time: new Date(time).toISOString(),
      time_ms: Number(payload?.time_ms) || Date.parse(time),
      interval_ms: Number.isFinite(intervalMs) && intervalMs >= 0 ? Math.trunc(intervalMs) : null,
      block_hash: String(payload?.block_hash || ''),
      has_swap_events: Boolean(payload?.has_swap_events),
      income_burn_e8: /^\d+$/.test(incomeBurn) ? BigInt(incomeBurn).toString() : null,
      pol_reserve_reward_e8: /^\d+$/.test(polReserveReward) ? BigInt(polReserveReward).toString() : null,
      pol_reserve_deployments: polReserveDeployments,
      source: String(payload?.source || 'liquify-ws')
    };
  } catch {
    return null;
  }
}

export function buildChainEventStreamUrl(options = {}) {
  return buildBooneToolsApiUrl(
    options.base || booneToolsApiConfig.base,
    '/chain-events'
  );
}

export function subscribeChainHeads(options = {}) {
  const EventSourceCtor = options.EventSourceCtor || globalThis.EventSource;
  if (typeof EventSourceCtor !== 'function') {
    options.onUnavailable?.();
    return { close() {}, source: null };
  }

  const source = new EventSourceCtor(buildChainEventStreamUrl(options));
  const handleHead = (event) => {
    const head = parseChainHeadEvent(event?.data);
    if (head) options.onHead?.(head);
  };
  source.addEventListener?.('head', handleHead);
  source.onopen = (event) => options.onOpen?.(event);
  source.onerror = (event) => options.onError?.(event);

  return {
    source,
    close() {
      source.removeEventListener?.('head', handleHead);
      source.close?.();
    }
  };
}
