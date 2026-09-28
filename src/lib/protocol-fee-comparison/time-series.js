import { PROTOCOLS, DAY_MS, finite, formatComparisonUsd } from '../../../shared/protocol-fee-comparison/model.js';
import { buildTimeSeriesOption } from '../charts/time-series.js';
import { comparisonTooltip } from './options.js';

// These are monetary flows, including the signed USD value of NEAR's net
// issuance. Sum the same daily observations as the plotted net series; never
// show a partial subtotal as a covered bucket when any interior day is missing.
function comparisonBucket(rows, bucket, grain) {
  const fromDay = bucket.fromDay || bucket.day;
  const throughDay = bucket.throughDay || bucket.day;
  const expectedDays = (Date.parse(throughDay) - Date.parse(fromDay)) / DAY_MS + 1;
  const keys = ['incomeUsd', 'subsidyUsd', 'netUsd'];
  return { ...bucket, fromDay, throughDay, expectedDays,
    title: grain === 'day' ? 'DAILY' : 'WEEKLY',
    ...(grain === 'month' ? { month: bucket.day.slice(0, 7) } : {}),
    partial: Boolean(bucket.partial || bucket.provisional),
    protocols: Object.fromEntries(PROTOCOLS.map(({ id }) => {
      const observed = rows.map(row => row[id]).filter(point => keys.every(key => finite(point?.[key]) !== null));
      const complete = rows.length === expectedDays && observed.length === expectedDays;
      return [id, { complete, observedDays: observed.length, expectedDays,
        ...Object.fromEntries(keys.map(key => [key, complete ? observed.reduce((total, point) => total + Number(point[key]), 0) : null])) }];
    }))
  };
}

export function buildComparisonTimeSeries(rows, { sourceGrain = 'day', hidden = [], nearNetSupply = false, ...viewport } = {}) {
  return buildTimeSeriesOption(rows, { ...viewport, hidden, sourceGrain,
    axes: [{ id: 'net', label: 'NET INCOME · USD', color: '#c8c8c8', position: 'left', baseline: 'signed', format: value => formatComparisonUsd(value, true) }],
    series: PROTOCOLS.map(item => ({ ...item, aggregate: 'sum', axis: 'net', mark: 'bar',
      data: rows.map(row => sourceGrain === 'month' ? row.protocols?.[item.id]?.netUsd : row[item.id]?.netUsd) })),
    tooltip: row => comparisonTooltip(sourceGrain === 'month' ? row : comparisonBucket([row], row, 'day'), hidden, nearNetSupply),
    groupedTooltip: (bucket, context) => comparisonTooltip(comparisonBucket(context.rows, bucket, context.grain), context.hidden, nearNetSupply)
  });
}
