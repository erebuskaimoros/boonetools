import { booneToolsApi } from '../api/boonetools.js';

function fetchAppLayerEndpoint(path, options = {}) {
  return booneToolsApi.get(path, {
    cache: options.forceRefresh ? 'no-cache' : undefined,
    signal: options.signal,
    preferPayloadError: false,
    errorMessage: ({ response, body }) => (
      `${response.status} ${response.statusText}: ${body.slice(0, 160)}`
    ),
    challengeMessage: 'App Layer backend returned a challenge response'
  });
}

export function fetchAppLayerLiveState(options = {}) {
  return fetchAppLayerEndpoint('/app-layer-live-state', options);
}

export function fetchAppLayerBaseFees(options = {}) {
  return fetchAppLayerEndpoint('/app-layer-base-fees', options);
}

export function fetchAppLayerBaseLayerEarnings(options = {}) {
  return fetchAppLayerEndpoint('/app-layer-base-layer-earnings', options);
}

export function fetchAppLayerReservePayments(options = {}) {
  return fetchAppLayerEndpoint('/app-layer-reserve-payments', options);
}
