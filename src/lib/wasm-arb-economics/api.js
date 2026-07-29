import { booneToolsApi } from '../api/boonetools.js';

export async function fetchWasmArbEconomics(options = {}) {
  return booneToolsApi.get('/wasm-arb-economics', {
    cache: options.forceRefresh ? 'no-cache' : undefined,
    errorMessage: ({ response }) => `Wasm arb economics request failed (${response.status})`,
    challengeMessage: 'Wasm arb economics backend returned a challenge response'
  });
}
