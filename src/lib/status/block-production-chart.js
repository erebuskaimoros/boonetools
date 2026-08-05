function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function buildBlockProductionChartScale(points = [], options = {}) {
  const targetSeconds = Math.max(0, finiteNumber(options.targetSeconds) ?? 6);
  const tickIntervals = Math.max(1, Math.round(finiteNumber(options.tickIntervals) ?? 4));
  const minimumSpanSeconds = Math.max(0.1, finiteNumber(options.minimumSpanSeconds) ?? 0.5);
  const values = (Array.isArray(points) ? points : [])
    .map((point) => finiteNumber(point?.seconds ?? point?.seconds_per_block ?? point))
    .filter((value) => value !== null && value > 0);

  values.push(targetSeconds);
  let dataMin = Math.min(...values);
  let dataMax = Math.max(...values);
  if (dataMax - dataMin < minimumSpanSeconds) {
    const midpoint = (dataMin + dataMax) / 2;
    dataMin = midpoint - (minimumSpanSeconds / 2);
    dataMax = midpoint + (minimumSpanSeconds / 2);
  }

  const padding = Math.max((dataMax - dataMin) * 0.04, 0.02);
  const min = Math.max(0, dataMin - padding);
  const max = dataMax + padding;
  const step = (max - min) / tickIntervals;
  const ticks = Array.from({ length: tickIntervals + 1 }, (_, index) => (
    Number((max - (step * index)).toPrecision(12))
  ));

  return { min, max, step, ticks };
}

export function projectBlockProductionChartY(value, options = {}) {
  const numeric = finiteNumber(value);
  const min = finiteNumber(options.min);
  const max = finiteNumber(options.max);
  const top = finiteNumber(options.top);
  const bottom = finiteNumber(options.bottom);
  if (
    numeric === null
    || min === null
    || max === null
    || top === null
    || bottom === null
    || max <= min
    || bottom <= top
  ) return null;

  const bounded = Math.max(min, Math.min(max, numeric));
  return top + (((max - bounded) / (max - min)) * (bottom - top));
}

export function findNearestBlockProductionPointIndex(points = [], timestamp) {
  const targetTimestamp = finiteNumber(timestamp);
  if (!Array.isArray(points) || points.length === 0 || targetTimestamp === null) return null;

  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = finiteNumber(points[middle]?.timestamp);
    if (value === null) return findNearestValidPoint(points, targetTimestamp);
    if (value < targetTimestamp) low = middle + 1;
    else if (value > targetTimestamp) high = middle - 1;
    else return middle;
  }

  if (low <= 0) return 0;
  if (low >= points.length) return points.length - 1;
  const left = finiteNumber(points[low - 1]?.timestamp);
  const right = finiteNumber(points[low]?.timestamp);
  if (left === null || right === null) return findNearestValidPoint(points, targetTimestamp);
  return targetTimestamp - left <= right - targetTimestamp ? low - 1 : low;
}

function findNearestValidPoint(points, targetTimestamp) {
  let nearestIndex = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => {
    const timestamp = finiteNumber(point?.timestamp);
    if (timestamp === null) return;
    const distance = Math.abs(timestamp - targetTimestamp);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  });
  return nearestIndex;
}

export function decodeBlockIntervalPayload(payload = {}) {
  const columns = Array.isArray(payload?.columns) ? payload.columns : [];
  const heightIndex = columns.indexOf('height');
  const timeIndex = columns.indexOf('time_ms');
  const intervalIndex = columns.indexOf('interval_ms');
  const swapIndex = columns.indexOf('has_swap_events');
  if (heightIndex < 0 || timeIndex < 0 || intervalIndex < 0) return [];

  return (Array.isArray(payload?.points) ? payload.points : [])
    .map((tuple) => {
      if (!Array.isArray(tuple)) return null;
      const height = finiteNumber(tuple[heightIndex]);
      const timeMs = finiteNumber(tuple[timeIndex]);
      const intervalMs = finiteNumber(tuple[intervalIndex]);
      if (
        height === null || height <= 0
        || timeMs === null || !Number.isFinite(new Date(timeMs).getTime())
        || intervalMs === null || intervalMs <= 0
      ) return null;
      return {
        time: new Date(timeMs).toISOString(),
        height: Math.trunc(height),
        seconds_per_block: intervalMs / 1000,
        block_count: 1,
        has_swap_events: swapIndex >= 0 ? Boolean(tuple[swapIndex]) : false,
        source: 'liquify-ws-header'
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.height - right.height);
}

export function chainHeadToBlockIntervalPoint(head = {}) {
  const height = finiteNumber(head.height);
  const intervalMs = finiteNumber(head.interval_ms);
  const timestamp = finiteNumber(head.time_ms) ?? finiteNumber(Date.parse(String(head.time || '')));
  if (height === null || height <= 0 || intervalMs === null || intervalMs <= 0 || timestamp === null) {
    return null;
  }
  return {
    time: new Date(timestamp).toISOString(),
    height: Math.trunc(height),
    seconds_per_block: intervalMs / 1000,
    block_count: 1,
    has_swap_events: Boolean(head.has_swap_events),
    source: 'liquify-ws-header'
  };
}

export function mergeBlockIntervalPoints(current = [], incoming = [], options = {}) {
  const byHeight = new Map();
  for (const point of [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const height = finiteNumber(point?.height);
    const timestamp = Date.parse(String(point?.time || ''));
    const seconds = finiteNumber(point?.seconds_per_block);
    if (height === null || height <= 0 || !Number.isFinite(timestamp) || seconds === null || seconds <= 0) continue;
    byHeight.set(Math.trunc(height), { ...point, height: Math.trunc(height) });
  }
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const windowMs = Math.max(60_000, Number(options.windowMs) || (24 * 60 * 60 * 1000));
  return [...byHeight.values()]
    .filter((point) => Date.parse(point.time) >= nowMs - windowMs)
    .sort((left, right) => left.height - right.height);
}
