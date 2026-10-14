import { PROTOCOLS, DAY_MS, finite, formatComparisonUsd } from '../../../shared/protocol-fee-comparison/model.js';
import { buildTimeSeriesOption } from '../charts/time-series.js';
import { comparisonTooltip } from './options.js';

const observedContribution = point => ['incomeUsd', 'subsidyUsd', 'netUsd']
  .every(key => finite(point?.[key]) !== null);
const sharedMonth = row => PROTOCOLS.every(({ id }) => row.protocols?.[id]?.complete
  && observedContribution(row.protocols[id]));

// The latest continuous overlap is one common comparison window, not three
// protocol-specific ranges. An observed zero is covered; a missing day is not.
function latestVerifiedRun(rows, covered, consecutive) {
  const last = rows.findLastIndex(covered);
  if (last < 0) return [];
  let first = last;
  while (first > 0 && covered(rows[first - 1]) && consecutive(rows[first - 1], rows[first])) first -= 1;
  return rows.slice(first, last + 1);
}

export function selectComparisonView(daily = [], months = [], { mode = null } = {}) {
  const sourceGrain = daily.length ? 'day' : 'month';
  const history = (daily.length ? [...daily] : months.map(row => ({ ...row, day: row.fromDay })))
    .sort((a, b) => a.day.localeCompare(b.day));
  const verified = sourceGrain === 'day'
    ? latestVerifiedRun(history, row => PROTOCOLS.every(({ id }) => observedContribution(row[id])),
      (previous, next) => Date.parse(next.day) - Date.parse(previous.day) === DAY_MS)
    : latestVerifiedRun(history, sharedMonth, (previous, next) =>
      Date.parse(next.fromDay) - Date.parse(previous.throughDay) === DAY_MS);
  const selectedMode = mode === 'verified' || mode === 'full' ? mode
    : (months.some(row => !row.partial && sharedMonth(row)) || !verified.length ? 'full' : 'verified');
  const rows = selectedMode === 'verified' ? verified : history;
  return { mode: selectedMode, sourceGrain, grain: selectedMode === 'full' ? 'month' : sourceGrain, rows,
    fromDay: rows[0]?.fromDay || rows[0]?.day || null,
    throughDay: rows.at(-1)?.throughDay || rows.at(-1)?.day || null };
}

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
        ...Object.fromEntries(keys.map(key => [key, complete ? observed.reduce((total, point) => total + Number(point[key]), 0) : null])),
        ...(id === 'thorchain' ? Object.fromEntries(['grossIncomeUsd', 'revshareUsd', 'incomeUsd', 'subsidyUsd'].map(key => [key,
          rows.length === expectedDays && rows.every(row => finite(row[id]?.[key]) !== null)
            ? rows.reduce((total, row) => total + Number(row[id][key]), 0) : null
        ])) : {}) }];
    }))
  };
}

export function buildComparisonTimeSeries(rows, { sourceGrain = 'day', hidden = [], nearNetSupply = false, thorchainRewardAccounting = false, ...viewport } = {}) {
  return buildTimeSeriesOption(rows, { ...viewport, hidden, sourceGrain,
    axes: [{ id: 'net', label: 'NET INCOME · USD', color: '#c8c8c8', position: 'left', baseline: 'signed', format: value => formatComparisonUsd(value, true) }],
    series: PROTOCOLS.map(item => ({ ...item, aggregate: 'sum', axis: 'net', mark: 'bar',
      data: rows.map(row => sourceGrain === 'month' ? row.protocols?.[item.id]?.netUsd : row[item.id]?.netUsd) })),
    tooltip: row => comparisonTooltip(sourceGrain === 'month' ? row : comparisonBucket([row], row, 'day'), hidden, nearNetSupply, thorchainRewardAccounting),
    groupedTooltip: (bucket, context) => comparisonTooltip(comparisonBucket(context.rows, bucket, context.grain), context.hidden, nearNetSupply, thorchainRewardAccounting)
  });
}
