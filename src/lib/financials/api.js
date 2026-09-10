import { booneToolsApi } from '../api/boonetools.js';

/** @param {string} range @param {{ signal?: AbortSignal }} [options] */
export async function fetchFinancials(range, { signal } = {}) {
  if (import.meta.env.DEV) {
    const response = await fetch(`/__financials?range=${range}`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Financials returned HTTP ${response.status}`);
    return data;
  }
  return booneToolsApi.get('/financials', { query: { range }, signal,
    errorMessage: ({ response }) => `Financials snapshot failed (${response.status})` });
}
