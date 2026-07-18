import { summarizeDuneError } from './dune.js';
import { fetchMidgardSwapHistory } from './midgard.js';
import { fetchRapidSwapMarketHistoryFromDune } from './rapid-swaps.js';

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const HOUR_HISTORY_DAYS = 180;
const DAY_HISTORY_DAYS = 1095;
const HOUR_OVERLAP_SECONDS = 48 * HOUR_SECONDS;
const DAY_OVERLAP_SECONDS = 14 * DAY_SECONDS;
const MIDGARD_MAX_INTERVALS_PER_REQUEST = 400;

function toIsoOrNull(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function latestTimestamp(values) {
  let latest = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const normalized = toIsoOrNull(value);
    const timestamp = Date.parse(normalized || '');
    if (Number.isFinite(timestamp) && timestamp > latestMs) {
      latest = normalized;
      latestMs = timestamp;
    }
  }
  return latest;
}

async function withTimeout(promise, timeoutMs, label) {
  const boundedMs = Math.max(0, Math.trunc(Number(timeoutMs) || 0));
  if (boundedMs <= 0) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${boundedMs}ms`)), boundedMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizedIntervals(payload) {
  return (Array.isArray(payload?.intervals) ? payload.intervals : [])
    .map((row) => ({
      startTime: String(Math.max(0, Math.trunc(Number(row?.startTime) || 0))),
      endTime: String(Math.max(0, Math.trunc(Number(row?.endTime) || 0))),
      totalVolumeUSD: String(Math.max(0, Math.trunc(Number(row?.totalVolumeUSD) || 0))),
      totalCount: String(Math.max(0, Math.trunc(Number(row?.totalCount) || 0)))
    }))
    .filter((row) => Number(row.startTime) > 0 && Number(row.endTime) > Number(row.startTime))
    .sort((left, right) => Number(left.startTime) - Number(right.startTime));
}

async function fetchMidgardRange(fetchMidgard, interval, from, to) {
  const step = interval === 'hour'
    ? HOUR_SECONDS
    : interval === 'day'
      ? DAY_SECONDS
      : 0;
  if (!step || to <= from) {
    return fetchMidgard({ interval, from: String(from), to: String(to) });
  }

  const intervalsByStart = new Map();
  let latestMeta = {};
  let chunks = 0;
  for (let chunkFrom = from; chunkFrom < to;) {
    const chunkTo = Math.min(
      to,
      chunkFrom + MIDGARD_MAX_INTERVALS_PER_REQUEST * step
    );
    const payload = await fetchMidgard({
      interval,
      from: String(chunkFrom),
      to: String(chunkTo)
    });
    const chunkIntervals = normalizedIntervals(payload);
    if (!chunkIntervals.length) {
      throw new Error(
        `Midgard swap-history ${interval} returned no intervals for ${chunkFrom}-${chunkTo}`
      );
    }
    for (const row of chunkIntervals) intervalsByStart.set(row.startTime, row);
    latestMeta = payload?.meta || latestMeta;
    chunks += 1;
    chunkFrom = chunkTo;
  }

  return {
    meta: {
      ...latestMeta,
      source: 'midgard',
      chunks
    },
    intervals: [...intervalsByStart.values()].sort((left, right) => (
      Number(left.startTime) - Number(right.startTime)
    ))
  };
}

function alignedStartSeconds(value, stepSeconds, fallback) {
  const parsed = Date.parse(value || '');
  const seconds = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : fallback;
  return Math.floor(seconds / stepSeconds) * stepSeconds;
}

function latestIntervalEnd(intervals) {
  return normalizedIntervals({ intervals }).reduce(
    (latest, row) => Math.max(latest, Number(row.endTime) || 0),
    0
  );
}

function mergeIntervals(previousIntervals, refreshedIntervals, from, to) {
  const merged = new Map();
  for (const row of [
    ...normalizedIntervals({ intervals: previousIntervals }),
    ...normalizedIntervals({ intervals: refreshedIntervals })
  ]) {
    const start = Number(row.startTime) || 0;
    if (start < from || start >= to) continue;
    merged.set(row.startTime, row);
  }
  return [...merged.values()].sort((left, right) => (
    Number(left.startTime) - Number(right.startTime)
  ));
}

async function fetchSegment(interval, from, to, options = {}) {
  const fetchDune = options.fetchDune || fetchRapidSwapMarketHistoryFromDune;
  const fetchMidgard = options.fetchMidgard || fetchMidgardSwapHistory;
  try {
    const payload = await withTimeout(
      fetchDune({ interval, from, to }),
      options.duneTimeoutMs,
      `Dune swap-history ${interval}`
    );
    const intervals = normalizedIntervals(payload);
    if (!intervals.length) throw new Error(`Dune swap-history ${interval} returned no intervals`);
    return {
      interval,
      from,
      to,
      source: 'dune',
      meta: payload.meta || {},
      intervals,
      warning: ''
    };
  } catch (duneError) {
    try {
      const payload = await withTimeout(
        fetchMidgardRange(fetchMidgard, interval, from, to),
        options.midgardTimeoutMs,
        `Midgard swap-history ${interval}`
      );
      const intervals = normalizedIntervals(payload);
      if (!intervals.length) throw new Error(`Midgard swap-history ${interval} returned no intervals`);
      const duneWarning = summarizeDuneError(duneError);
      return {
        interval,
        from,
        to,
        source: 'midgard',
        meta: payload.meta || {},
        intervals,
        warning: `Dune unavailable: ${duneWarning.message}`
      };
    } catch (midgardError) {
      const error = new Error(`Swap-history ${interval} refresh failed: ${midgardError.message || midgardError}`);
      error.duneError = duneError;
      error.midgardError = midgardError;
      throw error;
    }
  }
}

export async function buildRapidSwapMarketHistoryPayload(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const observedAt = now.toISOString();
  const to = Math.floor(now.getTime() / 1000 / HOUR_SECONDS) * HOUR_SECONDS;
  const previous = options.previous?.segments || {};
  const specs = [
    {
      key: 'hour',
      interval: 'hour',
      step: HOUR_SECONDS,
      historySeconds: HOUR_HISTORY_DAYS * DAY_SECONDS,
      overlapSeconds: HOUR_OVERLAP_SECONDS
    },
    {
      key: 'day',
      interval: 'day',
      step: DAY_SECONDS,
      historySeconds: DAY_HISTORY_DAYS * DAY_SECONDS,
      overlapSeconds: DAY_OVERLAP_SECONDS
    }
  ].map((spec) => {
    const retentionFrom = Math.min(
      to - spec.step,
      Math.max(
        to - spec.historySeconds,
        alignedStartSeconds(options.startTime, spec.step, to - spec.historySeconds)
      )
    );
    const previousEnd = latestIntervalEnd(previous[spec.key]?.intervals);
    const incrementalFrom = previousEnd > 0
      ? previousEnd - spec.overlapSeconds
      : retentionFrom;
    return {
      ...spec,
      from: Math.max(retentionFrom, Math.min(to - spec.step, incrementalFrom)),
      retentionFrom,
      to
    };
  });
  const segments = {};
  const warnings = [];

  const refreshedSegments = await Promise.all(specs.map(async (spec) => {
    try {
      const refreshed = await fetchSegment(spec.interval, spec.from, spec.to, options);
      const segment = {
        ...refreshed,
        from: spec.retentionFrom,
        refresh_from: spec.from,
        incremental: spec.from > spec.retentionFrom,
        intervals: mergeIntervals(
          previous[spec.key]?.intervals,
          refreshed.intervals,
          spec.retentionFrom,
          spec.to
        ),
        observed_at: observedAt,
        stale: false
      };
      return { key: spec.key, segment, warning: segment.warning || '' };
    } catch (error) {
      if (!previous[spec.key]?.intervals?.length) throw error;
      const warning = error.message || String(error);
      const retainedIntervals = mergeIntervals(
        previous[spec.key].intervals,
        [],
        spec.retentionFrom,
        spec.to
      );
      if (!retainedIntervals.length) throw error;
      return {
        key: spec.key,
        segment: {
          ...previous[spec.key],
          from: spec.retentionFrom,
          refresh_from: spec.from,
          incremental: spec.from > spec.retentionFrom,
          intervals: retainedIntervals,
          observed_at: toIsoOrNull(previous[spec.key].observed_at)
            || toIsoOrNull(options.previous?.source_updated_at)
            || toIsoOrNull(options.previous?.as_of),
          stale: true,
          warning
        },
        warning
      };
    }
  }));
  for (const result of refreshedSegments) {
    segments[result.key] = result.segment;
    if (result.warning) warnings.push(`${result.key}: ${result.warning}`);
  }

  const sourceUpdatedAt = latestTimestamp(Object.values(segments).map((segment) => (
    segment.observed_at
  ))) || toIsoOrNull(options.previous?.source_updated_at);
  const stale = Object.values(segments).some((segment) => segment.stale);

  return {
    schema_version: 1,
    as_of: observedAt,
    source_updated_at: sourceUpdatedAt,
    stale,
    segments,
    warning: warnings.join('; ')
  };
}

function aggregateIntervals(intervals, interval) {
  if (interval === 'hour' || interval === 'day') return intervals;
  const buckets = new Map();
  for (const row of intervals) {
    const start = Number(row.startTime) || 0;
    const date = new Date(start * 1000);
    let bucketStart;
    let bucketEnd;
    if (interval === 'month') {
      bucketStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
      bucketEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000;
    } else {
      const mondayOffset = (date.getUTCDay() + 6) % 7;
      bucketStart = Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate() - mondayOffset
      ) / 1000;
      bucketEnd = bucketStart + 7 * DAY_SECONDS;
    }
    if (!buckets.has(bucketStart)) {
      buckets.set(bucketStart, { end: bucketEnd, volume: 0, count: 0 });
    }
    const bucket = buckets.get(bucketStart);
    bucket.volume += Number(row.totalVolumeUSD) || 0;
    bucket.count += Number(row.totalCount) || 0;
  }
  return [...buckets.entries()].sort((left, right) => left[0] - right[0]).map(([start, row]) => ({
    startTime: String(start),
    endTime: String(row.end),
    totalVolumeUSD: String(Math.max(0, Math.trunc(row.volume))),
    totalCount: String(Math.max(0, Math.trunc(row.count)))
  }));
}

export function selectRapidSwapMarketHistory(payload, params = {}) {
  const interval = ['hour', 'day', 'week', 'month'].includes(params.interval)
    ? params.interval
    : 'hour';
  const segment = interval === 'hour' ? payload?.segments?.hour : payload?.segments?.day;
  if (!segment) return null;
  const to = Number(params.to || 0) || Math.floor(Date.now() / 1000);
  const count = Math.max(1, Number(params.count || 24) || 24);
  const step = interval === 'month' ? 30 * DAY_SECONDS
    : interval === 'week' ? 7 * DAY_SECONDS
      : interval === 'day' ? DAY_SECONDS
        : HOUR_SECONDS;
  const from = Number(params.from || 0) || Math.max(0, to - count * step);
  const sourceIntervals = aggregateIntervals(segment.intervals || [], interval);
  const intervals = sourceIntervals.filter((row) => (
    Number(row.startTime) >= from && Number(row.startTime) < to
  ));
  const earliest = Number(sourceIntervals[0]?.startTime || 0);
  if (from > 0 && earliest > 0 && from < earliest) {
    return {
      unavailable: true,
      earliest,
      requested_from: from
    };
  }
  const sourceUpdatedAt = toIsoOrNull(segment.observed_at)
    || toIsoOrNull(payload?.source_updated_at)
    || toIsoOrNull(payload?.as_of);
  const sourceUpdatedMs = Date.parse(sourceUpdatedAt || '');
  const nowMs = Number(params.nowMs ?? Date.now());
  return {
    meta: {
      ...(segment.meta || {}),
      source: `boonetools-read-model:${segment.source || 'unknown'}`,
      interval,
      from,
      to,
      generated_at: payload.as_of,
      source_updated_at: sourceUpdatedAt,
      source_age_seconds: Number.isFinite(sourceUpdatedMs)
        ? Math.max(0, Math.floor((nowMs - sourceUpdatedMs) / 1000))
        : null
    },
    intervals,
    stale: Boolean(payload?.stale || segment.stale),
    warning: segment.warning || payload.warning || ''
  };
}

export const rapidSwapMarketHistoryLimits = Object.freeze({
  hourHistoryDays: HOUR_HISTORY_DAYS,
  dayHistoryDays: DAY_HISTORY_DAYS
});
