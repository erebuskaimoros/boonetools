import { booneToolsApi } from '../api/boonetools.js';

/** @param {string} range @param {{ signal?: AbortSignal, bucket?: string }} [options] */
export async function fetchFinancials(range, { signal, bucket = 'day' } = {}) {
  const query = { range, ...(bucket === 'hour' ? { bucket } : {}) };
  if (import.meta.env.DEV) {
    const response = await fetch(`/__financials?${new URLSearchParams(query)}`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Financials returned HTTP ${response.status}`);
    return data;
  }
  return booneToolsApi.get('/financials', { query, signal,
    errorMessage: ({ response }) => `Financials snapshot failed (${response.status})` });
}

/** @param {string} day @param {{ signal?: AbortSignal }} [options] */
export async function fetchFinancialDay(day, { signal } = {}) {
  if (import.meta.env.DEV) {
    const response = await fetch(`/__financials?day=${encodeURIComponent(day)}`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Day details returned HTTP ${response.status}`);
    return data;
  }
  return booneToolsApi.get('/financials', { query: { day }, signal,
    errorMessage: ({ response }) => `Day details failed (${response.status})` });
}
