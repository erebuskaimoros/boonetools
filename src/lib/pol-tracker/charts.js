import { buildTimeSeriesOption, timeSeriesTooltip } from '../charts/time-series.js';
import { POL_TRACKER_SERIES, formatPolTrackerUsd, polTrackerStackValues, totalPolTrackerValue } from './model.js';

const areaFill = color => color + '57';

export function polTrackerTooltip(row, hidden = []) {
  return timeSeriesTooltip([
    row.day + ' · COMPLETED UTC DAY',
    ...POL_TRACKER_SERIES.filter(item => !hidden.includes(item.id)).map(item => ({
      id: item.id, color: item.color, fill: areaFill(item.color),
      text: item.label + ': ' + formatPolTrackerUsd(item.value(row))
    })),
    'TOTAL: ' + formatPolTrackerUsd(totalPolTrackerValue(row)),
    ...(row.complete === false ? ['Partial / missing valuations · gaps are not zero'] : [])
  ]);
}

export function buildPolTrackerOption(rows, { width = 1000, window = null, hidden = [], analysis = null } = {}) {
  const values = polTrackerStackValues(rows);
  return buildTimeSeriesOption(rows, {
    width, window, hidden, analysis,
    axes: [{ id: 'value', label: 'TRACKED VALUE · USD', position: 'left', color: '#aaa',
      format: value => formatPolTrackerUsd(value, true) }],
    series: POL_TRACKER_SERIES.map((item, index) => ({
      id: item.id, label: item.label, aggregate: 'last', axis: 'value', mark: 'line', stack: 'holdings',
      color: item.color, areaFill: areaFill(item.color), lineWidth: 1.4, data: values[index]
    })),
    tooltip: row => polTrackerTooltip(row, hidden)
  });
}
