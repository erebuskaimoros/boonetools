import { numericValue, rollingDailyValues, ROLLING_DAYS } from './analytics.js';

// A WeakMap keeps raw datasets/callbacks separate from overlays across Chart.js rebuilds.
export function createLegacyChartAnalytics() {
  const snapshots = new WeakMap();

  return function render(instance, points, history, definitions, hiddenIds, rollingIds) {
    if (!instance) return [];
    if (!snapshots.has(instance)) snapshots.set(instance, {
      datasets: instance.data.datasets.slice(),
      label: instance.options.plugins.tooltip?.callbacks?.label
    });
    const saved = snapshots.get(instance);
    const series = saved.datasets.map((dataset, index) => ({
      id: definitions[index]?.id || `series-${index}`, label: dataset.label,
      color: typeof dataset.borderColor === 'string' ? dataset.borderColor : '#00cc66',
      mark: dataset.type || instance.config.type, rolling: definitions[index]?.rolling !== false
    }));
    const overlays = series.flatMap((item, index) => {
      const metric = definitions[index];
      const source = history.length && metric?.value ? history : points;
      const values = source.map((row, rowIndex) => numericValue(metric?.value ? metric.value(row) : saved.datasets[index].data[rowIndex]));
      return ROLLING_DAYS.filter(days => item.rolling && rollingIds.includes(`${item.id}-${days}d`)).map(days => {
        const averaged = rollingDailyValues(source, values, days, metric?.rollingReduce || 'mean');
        return { type: 'line', label: `${days}D AVG · ${item.label}`, _dailyMean: true,
          data: points.map(row => {
            const last = source.findLast(point => point.day >= row.day && point.day <= (row.throughDay || row.day));
            return averaged.get(last?.day) ?? null;
          }),
          borderColor: item.color, backgroundColor: item.color,
          borderDash: days === 7 ? [] : days === 30 ? [8, 5] : [2, 4],
          borderWidth: 2, pointRadius: 0, pointHoverRadius: 3, fill: false, tension: 0,
          spanGaps: false, yAxisID: saved.datasets[index].yAxisID };
      });
    });
    instance.data.datasets = [...saved.datasets, ...overlays];
    instance.data.datasets.forEach((_dataset, index) => instance.setDatasetVisibility(index, index >= series.length || !hiddenIds.includes(series[index].id)));
    instance.options.plugins.legend.display = false;
    if (instance.options.plugins.tooltip) {
      instance.options.plugins.tooltip.displayColors = true;
      instance.options.plugins.tooltip.callbacks.label = context => context.dataset._dailyMean
        ? `${context.dataset.label}: ${context.formattedValue} · daily mean`
        : saved.label?.(context) ?? `${context.dataset.label}: ${context.formattedValue}`;
    }
    for (const [axis, config] of Object.entries(instance.options.scales || {})) {
      if (axis === 'x') continue;
      config.display = instance.data.datasets.some((dataset, index) => (dataset.yAxisID || 'y') === axis && instance.isDatasetVisible(index));
    }
    instance.update('none');
    return series;
  }
}
