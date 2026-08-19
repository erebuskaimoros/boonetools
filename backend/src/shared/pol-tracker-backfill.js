import { config } from '../lib/config.js';
import { buildPolTrackerObservation } from '../../../shared/pol-tracker/model.js';
import { fetchHistoricalPolTrackerState } from '../pol-tracker/providers.js';
import { resolvePoolDislocationBlockAnchors } from './pool-dislocation-backfill.js';
import {
  loadPolTrackerExistingDays,
  persistPolTrackerObservation,
  updatePolTrackerSyncState
} from './pol-tracker-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TRANSIENT_ERROR_PATTERN = /fetch failed|network|socket|timeout|timed out|aborted|cooling down|temporarily unavailable/i;

function dateString(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid POL Tracker date: ${value}`);
  return parsed.toISOString().slice(0, 10);
}

export function shiftUtcDay(day, offset) {
  const time = Date.parse(`${dateString(day)}T00:00:00Z`);
  return new Date(time + (Number(offset) * DAY_MS)).toISOString().slice(0, 10);
}

export function buildPolTrackerDays(startDate, endDate) {
  const start = Date.parse(`${dateString(startDate)}T00:00:00Z`);
  const end = Date.parse(`${dateString(endDate)}T00:00:00Z`);
  if (start > end) return [];
  const days = [];
  for (let cursor = start; cursor <= end; cursor += DAY_MS) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

export function polTrackerSampleTime(day) {
  return new Date(Date.parse(`${dateString(day)}T00:00:00Z`) + DAY_MS - 1).toISOString();
}

export function isTransientPolTrackerError(error) {
  const status = Number(error?.status) || 0;
  if (error?.transient || error?.name === 'ProviderCooldownError' || error?.name === 'AbortError') return true;
  if (status === 0 && TRANSIENT_ERROR_PATTERN.test(String(error?.message || ''))) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(delayMs) {
  return delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
}

export async function retryPolTrackerOperation(operation, options = {}) {
  const attempts = Math.max(1, Math.trunc(Number(
    options.attempts ?? config.polTrackerRetryAttempts
  )) || 1);
  const baseDelayMs = Math.max(0, Math.trunc(Number(
    options.baseDelayMs ?? config.polTrackerRetryBaseDelayMs
  )) || 0);
  const maxDelayMs = Math.max(baseDelayMs, Math.trunc(Number(
    options.maxDelayMs ?? config.polTrackerRetryMaxDelayMs
  )) || baseDelayMs);
  const sleepFor = options.sleep || sleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= attempts || !isTransientPolTrackerError(error)) throw error;
      const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      await options.onRetry?.({ attempt, nextAttempt: attempt + 1, attempts, delayMs, error });
      await sleepFor(delayMs);
    }
  }
  throw new Error('POL Tracker retry loop exhausted unexpectedly');
}

export async function loadPolTrackerBackfillPlan(client, options = {}) {
  const startDate = dateString(options.startDate || config.polTrackerStartDate);
  const endDate = dateString(options.endDate);
  const existing = await (options.loadExistingDays || loadPolTrackerExistingDays)(
    client,
    startDate,
    endDate
  );
  const existingByDay = new Map(existing.map((row) => [dateString(row.day), Boolean(row.complete)]));
  const retryPartial = options.retryPartial !== false;
  const allDays = buildPolTrackerDays(startDate, endDate);
  const storedDays = [...existingByDay.keys()].sort();
  return {
    startDate,
    endDate,
    allDays,
    lastStoredDay: storedDays.at(-1) || null,
    pendingDays: allDays.filter((day) => !existingByDay.has(day) || (retryPartial && !existingByDay.get(day)))
  };
}

export async function resolvePolTrackerAnchors(days, options = {}) {
  const resolveAnchors = options.resolveAnchors || resolvePoolDislocationBlockAnchors;
  const anchors = await resolveAnchors(days.map(polTrackerSampleTime), {
    rpcUrls: options.rpcUrls || config.polTrackerRpcUrls,
    requestDelayMs: options.requestDelayMs ?? config.polTrackerRequestDelayMs,
    fetchStatus: options.fetchStatus,
    fetchBlock: options.fetchBlock,
    client: options.client,
    timeoutMs: options.timeoutMs || config.polTrackerTimeoutMs,
    cooldownScope: 'pol-tracker-history'
  });
  return anchors.map((anchor, index) => ({
    day: days[index],
    height: anchor.height,
    blockTime: anchor.blockTime,
    sampleTime: anchor.observedAt
  }));
}

export async function collectPolTrackerDay(anchor, options = {}) {
  const fetchState = options.fetchState || fetchHistoricalPolTrackerState;
  const state = await fetchState(anchor.height, {
    client: options.client,
    thornodeUrls: options.thornodeUrls || config.polTrackerThornodeUrls,
    moduleAddress: options.moduleAddress,
    reserveModuleAddress: options.reserveModuleAddress,
    concurrency: options.lpConcurrency,
    requestDelayMs: options.requestDelayMs,
    timeoutMs: options.timeoutMs || config.polTrackerTimeoutMs
  });
  return buildPolTrackerObservation({
    day: anchor.day,
    anchor,
    ...state
  });
}

function progressLogger(event) {
  console.log(JSON.stringify({ type: 'pol_tracker_progress', ...event }));
}

export async function ingestPolTrackerHistory(client, options = {}) {
  const plan = await (options.loadPlan || loadPolTrackerBackfillPlan)(client, options);
  const batchSize = Math.max(1, Math.trunc(Number(
    options.anchorBatchDays ?? config.polTrackerAnchorBatchDays
  )) || 1);
  const logProgress = options.logProgress || progressLogger;
  let processed = 0;
  let complete = 0;
  let partial = 0;
  let lastCompletedDay = plan.lastStoredDay || null;

  for (let offset = 0; offset < plan.pendingDays.length; offset += batchSize) {
    const batch = plan.pendingDays.slice(offset, offset + batchSize);
    let anchors;
    try {
      anchors = await retryPolTrackerOperation(
        () => (options.resolveBatchAnchors || resolvePolTrackerAnchors)(batch, { ...options, client }),
        options
      );
    } catch (error) {
      await (options.updateSync || updatePolTrackerSyncState)(client, {
        startDate: plan.startDate,
        nextDay: batch[0],
        lastCompletedDay,
        lastError: error?.message || String(error),
        stats: { expected: plan.allDays.length, pending: plan.pendingDays.length, processed, complete, partial }
      }).catch(() => {});
      throw error;
    }
    for (const anchor of anchors) {
      try {
        const observation = await retryPolTrackerOperation(
          () => (options.collectDay || collectPolTrackerDay)(anchor, { ...options, client }),
          options
        );
        await (options.persist || persistPolTrackerObservation)(client, observation);
        processed += 1;
        if (observation.daily.complete) complete += 1;
        else partial += 1;
        lastCompletedDay = anchor.day;
        await (options.updateSync || updatePolTrackerSyncState)(client, {
          startDate: plan.startDate,
          nextDay: shiftUtcDay(anchor.day, 1),
          lastCompletedDay,
          stats: { expected: plan.allDays.length, pending: plan.pendingDays.length, processed, complete, partial }
        });
        logProgress({
          day: anchor.day,
          height: anchor.height,
          processed,
          pending: plan.pendingDays.length,
          complete: observation.daily.complete
        });
      } catch (error) {
        await (options.updateSync || updatePolTrackerSyncState)(client, {
          startDate: plan.startDate,
          nextDay: anchor.day,
          lastCompletedDay,
          lastError: error?.message || String(error),
          stats: { expected: plan.allDays.length, pending: plan.pendingDays.length, processed, complete, partial }
        }).catch(() => {});
        throw error;
      }
    }
  }

  return {
    start_date: plan.startDate,
    end_date: plan.endDate,
    expected_days: plan.allDays.length,
    pending_days: plan.pendingDays.length,
    processed_days: processed,
    complete_days: complete,
    partial_days: partial,
    last_completed_day: lastCompletedDay
  };
}
