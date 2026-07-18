import { config } from '../lib/config.js';
import { requestFromProviders } from '../lib/provider-client.js';
import { sleep } from '../lib/utils.js';

const DUNE_HTTP_TIMEOUT_MS = 60_000;

function readExecutionState(payload) {
  return String(
    payload?.state
      || payload?.execution_state
      || payload?.executionStatus
      || payload?.execution_status?.state
      || ''
  ).toUpperCase();
}

function isCompleteState(state) {
  return /COMPLETED|SUCCESS/.test(state);
}

function isFailureState(state) {
  return /FAILED|CANCELLED|CANCELED|EXPIRED/.test(state);
}

function readDuneRows(payload) {
  if (Array.isArray(payload?.result?.rows)) return payload.result.rows;
  if (Array.isArray(payload?.data?.rows)) return payload.data.rows;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

function parseDuneDateTime(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function formatDuneDateTime(value) {
  const date = value instanceof Date ? value : parseDuneDateTime(value);
  if (!date) return '';
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function summarizeDuneError(error) {
  const message = error?.message || String(error || 'Dune request failed');
  const status = Number(error?.status || 0);
  const body = String(error?.body || '').trim();
  return {
    message,
    ...(status > 0 ? { status } : {}),
    ...(body ? { body: body.slice(0, 500) } : {})
  };
}

export function formatDuneError(error) {
  const summary = summarizeDuneError(error);
  const status = summary.status ? ` HTTP ${summary.status}` : '';
  const body = summary.body ? `: ${summary.body}` : '';
  return `Dune${status}: ${summary.message}${body}`;
}

export function isDuneLimitError(error) {
  const status = Number(error?.status || 0);
  const text = `${error?.message || ''} ${error?.body || ''}`;
  return status === 402
    || status === 429
    || /datapoint|quota|billing|limit|rate.?limit/i.test(text);
}

async function fetchDuneJson(path, options = {}) {
  if (!config.duneApiKey) {
    throw new Error('Missing required config: duneApiKey');
  }

  return requestFromProviders({
    bases: [config.duneApiBaseUrl],
    path,
    timeoutMs: Math.max(1, Number(options.timeoutMs) || DUNE_HTTP_TIMEOUT_MS),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Dune-API-Key': config.duneApiKey,
      ...(options.headers || {})
    },
    request: {
      method: options.method || 'GET',
      body: options.body ? JSON.stringify(options.body) : undefined
    },
    errorMessage: ({ status }) => `Dune API HTTP ${status} for ${path}`
  });
}

async function waitForDuneExecution(executionId) {
  const deadline = Date.now() + config.duneExecutionTimeoutMs;

  while (true) {
    const status = await fetchDuneJson(`/api/v1/execution/${executionId}/status`);
    const state = readExecutionState(status);

    if (isCompleteState(state)) return status;
    if (isFailureState(state)) {
      const message = status?.error?.message || status?.error || status?.message || state;
      throw new Error(`Dune execution ${executionId} failed: ${message}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Dune execution ${executionId} timed out after ${config.duneExecutionTimeoutMs}ms`);
    }

    await sleep(config.duneExecutionPollMs);
  }
}

export async function executeDuneQueryRows(queryId, queryParameters = {}, options = {}) {
  const id = String(queryId || '').trim();
  if (!id) {
    throw new Error('Missing Dune query id');
  }

  const body = {
    query_parameters: queryParameters
  };
  if (config.dunePerformance) {
    body.performance = config.dunePerformance;
  }

  const execution = await fetchDuneJson(`/api/v1/query/${encodeURIComponent(id)}/execute`, {
    method: 'POST',
    body
  });
  const executionId = execution?.execution_id || execution?.executionId;
  if (!executionId) {
    throw new Error(`Dune query ${id} did not return an execution id`);
  }

  const initialState = readExecutionState(execution);
  if (!isCompleteState(initialState)) {
    if (isFailureState(initialState)) {
      throw new Error(`Dune query ${id} execution failed: ${initialState}`);
    }
    await waitForDuneExecution(executionId);
  }

  const limit = Math.max(1, Math.min(32000, Math.trunc(Number(options.limit) || 32000)));
  const result = await fetchDuneJson(`/api/v1/execution/${encodeURIComponent(executionId)}/results?limit=${limit}`);
  const state = readExecutionState(result);
  if (state && !isCompleteState(state)) {
    throw new Error(`Dune execution ${executionId} returned non-complete state: ${state}`);
  }

  return {
    executionId,
    rows: readDuneRows(result),
    metadata: result?.result?.metadata || result?.metadata || {},
    raw: result
  };
}
