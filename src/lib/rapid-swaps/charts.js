import { getRapidSwapComparableVolumeUsd } from '../../../shared/rapid-swaps/volume.js';

export function toChartDateKey(value) {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    return '';
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dateFromChartDateKey(key) {
  const match = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isFinite(date.getTime()) ? date : null;
}

export function getChartDateRangeUnixSeconds(fromKey, toKey, options = {}) {
  const fromMatch = String(fromKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const toMatch = String(toKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!fromMatch || !toMatch) {
    return null;
  }
  const fromDate = dateFromChartDateKey(fromKey);
  const toDate = dateFromChartDateKey(toKey);
  const useUtc = options.utc === true;
  const rangeStartMs = useUtc
    ? Date.UTC(Number(fromMatch[1]), Number(fromMatch[2]) - 1, Number(fromMatch[3]))
    : fromDate.getTime();
  const rangeEndMs = useUtc
    ? Date.UTC(Number(toMatch[1]), Number(toMatch[2]) - 1, Number(toMatch[3]) + 1)
    : new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1).getTime();
  const nowSec = Math.floor(Date.now() / 1000);
  const rangeStart = Math.floor(rangeStartMs / 1000);
  const rawRangeEnd = Math.floor(rangeEndMs / 1000);
  const clampToNow = options.clampToNow !== false;
  const rangeEnd = clampToNow ? Math.min(rawRangeEnd, nowSec) : rawRangeEnd;

  return {
    from: rangeStart,
    to: Math.max(rangeStart, rangeEnd)
  };
}

function formatChartLabel(key) {
  const date = dateFromChartDateKey(key);
  if (!date) {
    return '';
  }

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });
}

export function getSeriesAxisBounds(values, options = {}) {
  const {
    paddingRatio = 0.08,
    minSpan = 1,
    clampMin = null,
    clampMax = null,
    roundToInteger = false
  } = options;

  const numericValues = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  if (!numericValues.length) {
    return {};
  }

  const minValue = Math.min(...numericValues);
  const maxValue = Math.max(...numericValues);
  const span = maxValue - minValue;
  const paddingBase = span > 0 ? span : Math.abs(maxValue || minValue || 0);
  const padding = Math.max(paddingBase * paddingRatio, minSpan);

  let min = minValue - padding;
  let max = maxValue + padding;

  if (clampMin != null) {
    min = Math.max(clampMin, min);
  }

  if (clampMax != null) {
    max = Math.min(clampMax, max);
  }

  if (roundToInteger) {
    min = Math.floor(min);
    max = Math.ceil(max);
  }

  if (!(max > min)) {
    max = min + (roundToInteger ? 1 : minSpan);
  }

  return { min, max };
}

export function computeDailyData(swaps, midgardHistory, allSwaps = swaps, options = {}) {
  if (!swaps.length) {
    return { labels: [], volume: [], cumVolume: [], count: [], cumCount: [], efficiency: [], pctFaster: [], volumePct: [], countPct: [] };
  }

  const byDay = {};
  for (const row of swaps) {
    const date = new Date(row.action_date);
    if (!Number.isFinite(date.getTime())) continue;
    const key = toChartDateKey(date);
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push(row);
  }

  const mgByDay = {};
  if (midgardHistory?.intervals?.length) {
    for (const interval of midgardHistory.intervals) {
      const key = toChartDateKey(new Date(Number(interval.startTime) * 1000));
      if (!key) {
        continue;
      }

      if (!mgByDay[key]) {
        mgByDay[key] = {
          volume: 0,
          count: 0
        };
      }

      mgByDay[key].volume += (Number(interval.totalVolumeUSD) || 0) / 1e2;
      mgByDay[key].count += Number(interval.totalCount) || 0;
    }
  }

  const sortedKeys = Object.keys(byDay).sort();
  const firstVisibleKey = sortedKeys[0];
  const labels = sortedKeys.map(formatChartLabel);

  const volume = [];
  const cumVolume = [];
  const count = [];
  const cumCount = [];
  const efficiency = [];
  const pctFaster = [];
  const volumePct = [];
  const countPct = [];
  let cumulativeVolume = Number(options.cumulativeVolumeBefore) || 0;
  let cumulativeCount = Number(options.cumulativeCountBefore) || 0;

  if (!options.useCumulativeSeeds) {
    for (const row of allSwaps) {
      const date = new Date(row.action_date);
      if (!Number.isFinite(date.getTime())) continue;
      const key = toChartDateKey(date);
      if (!key || key >= firstVisibleKey) continue;
      cumulativeVolume += getRapidSwapComparableVolumeUsd(row);
      cumulativeCount += 1;
    }
  }

  for (const key of sortedKeys) {
    const rows = byDay[key];
    const dayVolume = rows.reduce((sum, row) => sum + getRapidSwapComparableVolumeUsd(row), 0);
    cumulativeVolume += dayVolume;
    volume.push(dayVolume);
    cumVolume.push(cumulativeVolume);
    count.push(rows.length);
    cumulativeCount += rows.length;
    cumCount.push(cumulativeCount);

    let totalSubs = 0;
    let totalBlocks = 0;
    for (const row of rows) {
      const subs = Number(row.streaming_count) || 0;
      const blocks = Number(row.blocks_used) || 0;
      totalSubs += subs;
      totalBlocks += blocks;
    }
    efficiency.push(totalBlocks > 0 ? +(totalSubs / totalBlocks).toFixed(2) : 1);
    pctFaster.push(totalSubs > 0 ? +((1 - totalBlocks / totalSubs) * 100).toFixed(1) : 0);

    const comparableVolume = rows.reduce((sum, row) => sum + getRapidSwapComparableVolumeUsd(row), 0);
    const midgard = mgByDay[key];
    volumePct.push(midgard && midgard.volume > 0 ? +((comparableVolume / midgard.volume) * 100).toFixed(2) : null);
    countPct.push(midgard && midgard.count > 0 ? +((rows.length / midgard.count) * 100).toFixed(2) : null);
  }

  return { labels, volume, cumVolume, count, cumCount, efficiency, pctFaster, volumePct, countPct };
}

export function computeDailyBucketData(buckets, midgardHistory, options = {}) {
  const rows = (Array.isArray(buckets) ? buckets : [])
    .map((bucket) => ({
      ...bucket,
      key: String(bucket?.bucket_start || '').slice(0, 10)
    }))
    .filter((bucket) => /^\d{4}-\d{2}-\d{2}$/.test(bucket.key))
    .sort((left, right) => left.key.localeCompare(right.key));

  if (!rows.length) {
    return {
      labels: [], volume: [], cumVolume: [], count: [], cumCount: [],
      efficiency: [], pctFaster: [], volumePct: [], countPct: []
    };
  }

  const midgardByDay = {};
  for (const interval of midgardHistory?.intervals || []) {
    const date = new Date(Number(interval.startTime) * 1000);
    if (!Number.isFinite(date.getTime())) continue;
    const key = date.toISOString().slice(0, 10);
    if (!midgardByDay[key]) midgardByDay[key] = { volume: 0, count: 0 };
    midgardByDay[key].volume += (Number(interval.totalVolumeUSD) || 0) / 1e2;
    midgardByDay[key].count += Number(interval.totalCount) || 0;
  }

  let cumulativeVolume = Number(options.cumulativeVolumeBefore) || 0;
  let cumulativeCount = Number(options.cumulativeCountBefore) || 0;
  const output = {
    labels: [], volume: [], cumVolume: [], count: [], cumCount: [],
    efficiency: [], pctFaster: [], volumePct: [], countPct: []
  };

  for (const bucket of rows) {
    const volume = Number(bucket.comparable_volume_usd) || 0;
    const count = Number(bucket.swap_count) || 0;
    const totalSubs = Number(bucket.total_subs) || 0;
    const totalBlocks = Number(bucket.total_blocks_used) || 0;
    const midgard = midgardByDay[bucket.key];
    cumulativeVolume += volume;
    cumulativeCount += count;

    output.labels.push(formatChartLabel(bucket.key));
    output.volume.push(volume);
    output.cumVolume.push(cumulativeVolume);
    output.count.push(count);
    output.cumCount.push(cumulativeCount);
    output.efficiency.push(totalBlocks > 0 ? +(totalSubs / totalBlocks).toFixed(2) : 1);
    output.pctFaster.push(totalSubs > 0 ? +((1 - totalBlocks / totalSubs) * 100).toFixed(1) : 0);
    output.volumePct.push(midgard?.volume > 0 ? +((volume / midgard.volume) * 100).toFixed(2) : null);
    output.countPct.push(midgard?.count > 0 ? +((count / midgard.count) * 100).toFixed(2) : null);
  }

  return output;
}
