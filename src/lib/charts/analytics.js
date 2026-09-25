// Renderer-independent calendar math. Features explicitly declare sum (flows),
// last (stocks/cumulative totals), mean, or a domain-owned weighted reducer.
export const DAY_MS = 86400000;
export const ROLLING_DAYS = [7, 30, 90];
export const numericValue = value => Number.isFinite(value) ? value : Number.isFinite(value?.value) ? value.value : null;
const iso = time => new Date(time).toISOString().slice(0, 10);

export function calendarBounds(day, grain = 'day') {
  const date = new Date(`${String(day).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(+date)) return null;
  if (grain === 'week') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  if (grain === 'month') date.setUTCDate(1);
  const start = +date;
  if (grain === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
  else date.setUTCDate(date.getUTCDate() + (grain === 'week' ? 7 : 1));
  return { startDay: iso(start), endDay: iso(+date - DAY_MS), days: (+date - start) / DAY_MS };
}

/** @param {any[]} rows @param {any[]} values @param {string | Function} reduction */
export function reduceObservations(rows, values, reduction = 'mean') {
  if (!values.length) return null;
  if (typeof reduction === 'function') return numericValue(reduction(rows, values));
  if (reduction === 'last') return numericValue(values.at(-1));
  if (values.some(value => numericValue(value) === null)) return null;
  const sum = values.reduce((total, value) => total + numericValue(value), 0);
  return reduction === 'sum' ? sum : sum / values.length;
}

export function calendarGroups(rows, grain) {
  const groups = new Map();
  rows.forEach((row, index) => {
    const bounds = calendarBounds(row.day, grain);
    if (!bounds) return;
    if (!groups.has(bounds.startDay)) groups.set(bounds.startDay, { ...bounds, indices: [] });
    groups.get(bounds.startDay).indices.push(index);
  });
  return [...groups.values()].sort((a, b) => a.startDay.localeCompare(b.startDay));
}

/** @param {any[]} rows @param {any[]} values @param {number} days @param {string | Function} reduction */
export function rollingDailyValues(rows, values, days, reduction = 'mean') {
  const result = new Map();
  rows.forEach((row, index) => {
    const start = index - days + 1;
    const sample = start < 0 ? [] : rows.slice(start, index + 1);
    const consecutive = sample.length === days && sample.every((point, offset) =>
      Date.parse(point.day) === Date.parse(row.day) - (days - offset - 1) * DAY_MS);
    result.set(row.day, consecutive ? reduceObservations(sample, values.slice(start, index + 1), reduction) : null);
  });
  return result;
}

export function analysisLegend(series) {
  const seen = new Set();
  return series.filter(item => {
    const id = item.visibilityId || item.id;
    if (seen.has(id) || item.legend === false) return false;
    seen.add(id); return true;
  }).map(item => ({ ...item, id: item.visibilityId || item.id }));
}

export function analyzeTimeSeries(rows, spec, settings = {}) {
  const sourceGrain = spec.sourceGrain || 'day';
  const grain = sourceGrain !== 'day' ? sourceGrain : settings.grain || sourceGrain;
  const hidden = settings.hidden || [];
  const groups = calendarGroups(rows, grain);
  const grouped = grain !== sourceGrain;
  const plottedRows = grouped ? groups.map(group => ({
    day: group.startDay, endDay: group.endDay,
    fromDay: rows[group.indices[0]].day, throughDay: rows[group.indices.at(-1)].day,
    partial: group.indices.length < group.days || group.indices.some(index => rows[index].partial || rows[index].provisional),
    observations: group.indices.length
  })) : rows;
  const primary = spec.series.map(item => ({ ...item,
    label: grouped ? item.label?.replace(/^DAILY /i, grain === 'week' ? 'WEEKLY ' : 'MONTHLY ') : item.label,
    data: grouped && item.visibilityId ? [] : grouped ? groups.map(group => {
      const selected = group.indices.map(index => rows[index]);
      const expected = (Date.parse(selected.at(-1).day) - Date.parse(selected[0].day)) / DAY_MS + 1;
      // Interior source gaps must not masquerade as a complete flow/rate.
      if (sourceGrain === 'day' && selected.length !== expected && item.aggregate !== 'last') return null;
      return reduceObservations(selected, group.indices.map(index => numericValue((item.aggregateData || item.data)[index])), item.aggregate);
    }) : item.data,
    ...(grouped ? { markers: [], symbolSize: 0, fill: typeof item.fill === 'function' ? item.color : item.fill } : {})
  }));
  const source = settings.historySpec || spec;
  const historyRows = settings.historyRows?.length ? settings.historyRows : rows;
  const averages = sourceGrain !== 'day' ? [] : analysisLegend(spec.series).filter(item => item.rolling !== false).flatMap(item => {
    const original = source.series.find(series => series.id === item.id) || item;
    // Fresh visible observations replace any older cached lookback for that day.
    const indexed = new Map(historyRows.map((row, index) => [row.day, { row, value: numericValue((original.rollingData || original.data)[index]) }]));
    rows.forEach((row, index) => indexed.set(row.day, { row, value: numericValue((item.rollingData || item.data)[index]) }));
    const full = [...indexed.values()].sort((a, b) => a.row.day.localeCompare(b.row.day));
    return ROLLING_DAYS.filter(days => settings.rolling?.includes(`${item.id}-${days}d`)).map((days, index) => {
      const values = rollingDailyValues(full.map(point => point.row), full.map(point => point.value), days, item.rollingReduce || 'mean');
      return { ...item, id: `${item.id}-${days}d`, visibilityId: undefined,
        label: `${days}D AVG · ${item.label}`, mark: 'line', stack: undefined, areaFill: undefined,
        fill: undefined, smooth: false, symbolSize: 0, markers: [],
        lineType: ['solid', 'dashed', 'dotted'][ROLLING_DAYS.indexOf(days)], lineWidth: 2,
        data: plottedRows.map(row => values.get(row.throughDay || row.day) ?? null) };
    });
  });
  const visible = [...primary.filter(item => !hidden.includes(item.visibilityId || item.id)), ...averages];
  const axes = spec.axes.map(axis => ({ ...axis,
    ...(grouped ? { label: axis.label?.replace(/DAILY/g, grain.toUpperCase()), min: undefined, max: undefined } : {})
  }));
  return { rows: plottedRows, series: [...primary.map(item => ({ ...item, data: hidden.includes(item.visibilityId || item.id) ? [] : item.data })), ...averages],
    visible, axes, hiddenAxes: axes.filter(axis => !visible.some(item => item.axis === axis.id)).map(axis => axis.id), grain, grouped };
}
