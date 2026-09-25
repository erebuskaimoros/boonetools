import { TERMINAL_CHART_PALETTE as palette } from '../charts/terminal.js';

const DAY_MS = 86_400_000;
export const POOL_ROLLING_AVERAGES = ['volume', 'fees'].flatMap((metric) =>
  [7, 30, 90].map((days, index) => ({
    id: `${metric}-${days}d`, axis: metric, field: `${metric}Usd`, days,
    label: `${days}D AVG ${metric.toUpperCase()}`, mark: 'line',
    color: metric === 'volume' ? palette.info : palette.amber,
    lineType: ['solid', 'dashed', 'dotted'][index]
  }))
);

// Visible rows override older cached history, including explicit missing values.
// Sorting/deduplication never mutates either source or changes the plot's range.
export function mergePoolRollingHistory(history = [], visible = []) {
  return [...new Map([...history, ...visible].map((row) => [row.day, row])).values()]
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day) && Number.isFinite(Date.parse(`${row.day}T00:00:00Z`)))
    .sort((a, b) => a.day.localeCompare(b.day));
}

// Each mean requires N consecutive observed UTC days, including the ending day.
// Known zero counts; missing data and insufficient warmup remain null. Partial
// days are included as reported, never extrapolated, and flagged in the tooltip.
export function buildPoolRollingAverages(history, selected = []) {
  const rows = mergePoolRollingHistory(history);
  const result = new Map(rows.map((row) => [row.day, {}]));
  const times = rows.map((row) => Date.parse(`${row.day}T00:00:00Z`));
  for (const option of POOL_ROLLING_AVERAGES.filter((item) => selected.includes(item.id))) {
    let sum = 0, observed = 0, partial = 0;
    const values = rows.map((row) => row.source !== 'missing' && Number.isFinite(row[option.field]) ? row[option.field] : null);
    rows.forEach((row, index) => {
      if (values[index] !== null) { sum += values[index]; observed += 1; }
      if (row.partial) partial += 1;
      if (index >= option.days) {
        const previous = index - option.days;
        if (values[previous] !== null) { sum -= values[previous]; observed -= 1; }
        if (rows[previous].partial) partial -= 1;
      }
      const complete = observed === option.days && times[index] - times[index - option.days + 1] === (option.days - 1) * DAY_MS;
      result.get(row.day)[option.id] = { value: complete ? sum / option.days : null, partial: complete && partial > 0 };
    });
  }
  return result;
}
