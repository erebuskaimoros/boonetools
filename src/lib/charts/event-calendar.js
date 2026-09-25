import { calendarGroups, reduceObservations } from './analytics.js';
import { buildTimeSeriesOption, timeSeriesTooltip } from './time-series.js';

// Calendar presentation of timestamped observations, without inventing events
// on empty days. Per-metric reducers preserve counts, rates and closing stocks.
function weighted(rows, metric, values) {
  const weights = rows.map(row => metric.weight ? metric.weight(row) : row[`${metric.id}Weight`]);
  const valid = values.map((value, index) => ({ value, weight: weights[index] })).filter(item => Number.isFinite(item.value) && item.weight > 0);
  const total = valid.reduce((sum, item) => sum + item.weight, 0);
  return total ? valid.reduce((sum, item) => sum + item.value * item.weight, 0) / total : null;
}

export function eventCalendarDays(events, metrics) {
  const rows = events.filter(row => Number.isFinite(Date.parse(row.time)))
    .map(row => ({ ...row, day: new Date(row.time).toISOString().slice(0, 10) }))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return calendarGroups(rows, 'day').map(group => {
    const sample = group.indices.map(index => rows[index]);
    return { day: group.startDay, partial: true, samples: sample.length,
      ...Object.fromEntries(metrics.flatMap(metric => [
        [metric.id, metric.weight ? weighted(sample, metric, sample.map(metric.value)) : reduceObservations(sample, (metric.reduce || 'mean') === 'mean' ? sample.map(metric.value).filter(Number.isFinite) : sample.map(metric.value), metric.reduce || 'mean')],
        [`${metric.id}Weight`, sample.reduce((sum, row) => sum + (Number.isFinite(metric.value(row)) ? metric.weight ? metric.weight(row) : 1 : 0), 0)]
      ])) };
  });
}

export function buildEventCalendarOption(rows, { metrics = [], hidden = [], ...viewport } = {}) {
  const option = buildTimeSeriesOption(rows, { ...viewport, hidden,
    axes: metrics.map((metric, index) => ({ id: metric.id, label: metric.label, color: metric.color,
      position: index === 0 ? 'left' : 'right', baseline: metric.baseline || 'auto', format: metric.format || (value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 3 })) })),
    series: metrics.map(metric => ({ ...metric, axis: metric.id, mark: metric.mark || 'line',
      aggregate: metric.weight || (metric.reduce || 'mean') === 'mean' ? (sample, values) => weighted(sample, { id: metric.id }, values) : metric.aggregate || 'mean',
      rollingReduce: metric.weight || (metric.reduce || 'mean') === 'mean' ? (sample, values) => weighted(sample, { id: metric.id }, values) : 'mean',
      data: rows.map(row => row[metric.id]) })),
    tooltip: row => timeSeriesTooltip([`${row.day} · UTC · ${row.samples} observations · partial-day coverage`,
      ...metrics.filter(metric => !hidden.includes(metric.id)).map(metric => ({ ...metric,
        text: `${metric.label}: ${row[metric.id] == null ? 'unavailable' : metric.format?.(row[metric.id]) ?? row[metric.id]}` }))])
  });
  return option;
}
