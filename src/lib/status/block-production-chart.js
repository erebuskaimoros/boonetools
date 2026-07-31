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
