import { booneToolsApi } from '../api/boonetools.js';
import { localTimeZone } from '../utils/datetime.js';

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

/** @param {string} day @param {{ signal?: AbortSignal, timeZone?: string }} [options] */
export async function fetchFinancialDay(day, { signal, timeZone = localTimeZone() } = {}) {
  const query = { day, timeZone };
  if (import.meta.env?.DEV) {
    const response = await fetch(`/__financials?${new URLSearchParams(query)}`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Day details returned HTTP ${response.status}`);
    return data;
  }
  return booneToolsApi.get('/financials', { query, signal,
    errorMessage: ({ response }) => `Day details failed (${response.status})` });
}
