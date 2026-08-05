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
    return {
      height: Math.trunc(height),
      time: new Date(time).toISOString(),
      time_ms: Number(payload?.time_ms) || Date.parse(time),
      interval_ms: Number.isFinite(intervalMs) && intervalMs >= 0 ? Math.trunc(intervalMs) : null,
      block_hash: String(payload?.block_hash || ''),
      has_swap_events: Boolean(payload?.has_swap_events),
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
