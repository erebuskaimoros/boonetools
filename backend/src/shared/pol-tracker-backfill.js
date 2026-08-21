import { config } from '../lib/config.js';
import { buildPolTrackerObservation } from '../../../shared/pol-tracker/model.js';
import { fetchHistoricalPolTrackerState } from '../pol-tracker/providers.js';
import {
  resolvePoolDislocationBlockAnchorsAcrossRpcRanges
} from './pool-dislocation-backfill.js';
import {
  loadPolTrackerExistingDays,
  persistPolTrackerObservation,
  updatePolTrackerSyncState
} from './pol-tracker-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TRANSIENT_ERROR_PATTERN = /fetch failed|network|socket|timeout|timed out|aborted|cooling down|temporarily unavailable/i;
const HISTORICAL_HEIGHT_UNAVAILABLE_PATTERN = /invalid height:\s*cannot query with height in the future/i;

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
  if (isPolTrackerHistoricalHeightUnavailable(error)) return false;
  const status = Number(error?.status) || 0;
  if (error?.transient || error?.name === 'ProviderCooldownError' || error?.name === 'AbortError') return true;
  if (status === 0 && TRANSIENT_ERROR_PATTERN.test(String(error?.message || ''))) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function isPolTrackerHistoricalHeightUnavailable(error) {
  return HISTORICAL_HEIGHT_UNAVAILABLE_PATTERN.test([
    error?.message,
    error?.reason,
    error?.body,
    error?.cause?.message
  ].filter(Boolean).join(' '));
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
    targetEndDayComplete: existingByDay.get(endDate) === true,
    pendingDays: allDays.filter((day) => !existingByDay.has(day) || (retryPartial && !existingByDay.get(day)))
  };
}

export async function resolvePolTrackerAnchors(days, options = {}) {
  const resolveAnchors = options.resolveAnchors
    || resolvePoolDislocationBlockAnchorsAcrossRpcRanges;
  const sampleTimes = days.map(polTrackerSampleTime);
  const daysBySampleTime = new Map(sampleTimes.map((sampleTime, index) => [sampleTime, days[index]]));
  const rpcUrls = [...new Set((options.rpcUrls || config.polTrackerRpcUrls).filter(Boolean))];
  const anchorOptions = {
    requestDelayMs: options.requestDelayMs ?? config.polTrackerRequestDelayMs,
    fetchStatus: options.fetchStatus,
    fetchBlock: options.fetchBlock,
    client: options.client,
    timeoutMs: options.timeoutMs || config.polTrackerTimeoutMs,
    cooldownScope: 'pol-tracker-history',
    skipPointsBeforeEarliest: true,
    skipPointsAtOrAfterLatest: true,
    allowUnresolved: true
  };
  const anchors = await resolveAnchors(sampleTimes, { ...anchorOptions, rpcUrls });
  return anchors.map((anchor) => {
    const sampleTime = new Date(anchor.observedAt).toISOString();
    const day = daysBySampleTime.get(sampleTime);
    if (!day) throw new Error(`Resolved POL Tracker anchor does not match a requested sample point: ${sampleTime}`);
    return {
      day,
      height: anchor.height,
      blockTime: anchor.blockTime,
      sampleTime: anchor.observedAt
    };
  });
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
  let unavailable = 0;
  let lastCompletedDay = plan.lastStoredDay || null;
  let targetEndDayComplete = plan.targetEndDayComplete
    ?? !plan.pendingDays.includes(plan.endDate);

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
        stats: {
          expected: plan.allDays.length,
          pending: plan.pendingDays.length,
          processed,
          complete,
          partial,
          unavailable
        }
      }).catch(() => {});
      throw error;
    }
    const anchorsByDay = new Map(anchors.map((anchor) => [anchor.day, anchor]));
    for (const day of batch) {
      const anchor = anchorsByDay.get(day);
      if (!anchor) {
        unavailable += 1;
        if (day === plan.endDate) targetEndDayComplete = false;
        const lastError = `No configured RPC provider resolved a historical anchor for ${day}`;
        await (options.updateSync || updatePolTrackerSyncState)(client, {
          startDate: plan.startDate,
          nextDay: shiftUtcDay(day, 1),
          lastCompletedDay,
          lastError,
          stats: {
            expected: plan.allDays.length,
            pending: plan.pendingDays.length,
            processed,
            complete,
            partial,
            unavailable
          }
        });
        logProgress({
          day,
          height: null,
          processed,
          pending: plan.pendingDays.length,
          complete: false,
          unavailable: true
        });
        continue;
      }
      try {
        const observation = await retryPolTrackerOperation(
          () => (options.collectDay || collectPolTrackerDay)(anchor, { ...options, client }),
          options
        );
        await (options.persist || persistPolTrackerObservation)(client, observation);
        processed += 1;
        if (observation.daily.complete) complete += 1;
        else partial += 1;
        if (anchor.day === plan.endDate) {
          targetEndDayComplete = Boolean(observation.daily.complete);
        }
        lastCompletedDay = anchor.day;
        await (options.updateSync || updatePolTrackerSyncState)(client, {
          startDate: plan.startDate,
          nextDay: shiftUtcDay(anchor.day, 1),
          lastCompletedDay,
          stats: {
            expected: plan.allDays.length,
            pending: plan.pendingDays.length,
            processed,
            complete,
            partial,
            unavailable
          }
        });
        logProgress({
          day: anchor.day,
          height: anchor.height,
          processed,
          pending: plan.pendingDays.length,
          complete: observation.daily.complete
        });
      } catch (error) {
        if (isPolTrackerHistoricalHeightUnavailable(error)) {
          unavailable += 1;
          if (anchor.day === plan.endDate) targetEndDayComplete = false;
          await (options.updateSync || updatePolTrackerSyncState)(client, {
            startDate: plan.startDate,
            nextDay: shiftUtcDay(anchor.day, 1),
            lastCompletedDay,
            lastError: error?.message || String(error),
            stats: {
              expected: plan.allDays.length,
              pending: plan.pendingDays.length,
              processed,
              complete,
              partial,
              unavailable
            }
          });
          logProgress({
            day: anchor.day,
            height: anchor.height,
            processed,
            pending: plan.pendingDays.length,
            complete: false,
            unavailable: true
          });
          continue;
        }
        await (options.updateSync || updatePolTrackerSyncState)(client, {
          startDate: plan.startDate,
          nextDay: anchor.day,
          lastCompletedDay,
          lastError: error?.message || String(error),
          stats: {
            expected: plan.allDays.length,
            pending: plan.pendingDays.length,
            processed,
            complete,
            partial,
            unavailable
          }
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
    unavailable_days: unavailable,
    last_completed_day: lastCompletedDay,
    target_end_day_complete: Boolean(targetEndDayComplete)
  };
}
