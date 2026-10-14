import { PROTOCOLS, DAY_MS, finite, formatComparisonUsd, comparisonDisplayDay, comparisonAccountingSummary,
  monthlyComparison, nextDay } from '../../../shared/protocol-fee-comparison/model.js';
import { buildTimeSeriesOption } from '../charts/time-series.js';
import { comparisonTooltip } from './options.js';

const observedContribution = point => ['incomeUsd', 'subsidyUsd', 'netUsd']
  .every(key => finite(point?.[key]) !== null);
const sharedMonth = row => PROTOCOLS.every(({ id }) => row.protocols?.[id]?.complete
  && observedContribution(row.protocols[id]));
const correctedPoint = point => point?.accounting !== 'legacy' && point?.accounting !== 'mixed';

// The latest continuous overlap is one common comparison window, not three
// protocol-specific ranges. An observed zero is covered; a missing day is not.
function latestVerifiedRun(rows, covered, consecutive) {
  const last = rows.findLastIndex(covered);
  if (last < 0) return [];
  let first = last;
  while (first > 0 && covered(rows[first - 1]) && consecutive(rows[first - 1], rows[first])) first -= 1;
  return rows.slice(first, last + 1);
}

export function selectComparisonView(daily = [], months = [], { mode = null, correctedAccounting = true } = {}) {
  const sourceGrain = daily.length ? 'day' : 'month';
  const history = (daily.length ? [...daily] : months.map(row => ({ ...row, day: row.fromDay })))
    .sort((a, b) => a.day.localeCompare(b.day));
  // Verify canonical observations before projecting any legacy display values.
  // Already-projected rows and pre-v4 snapshots must not become exact coverage.
  const verified = !correctedAccounting ? [] : sourceGrain === 'day'
    ? latestVerifiedRun(history, row => correctedPoint(row.thorchain) && PROTOCOLS.every(({ id }) => observedContribution(row[id])),
      (previous, next) => Date.parse(next.day) - Date.parse(previous.day) === DAY_MS)
    : latestVerifiedRun(history, row => correctedPoint(row.protocols?.thorchain) && sharedMonth(row), (previous, next) =>
      Date.parse(next.fromDay) - Date.parse(previous.throughDay) === DAY_MS);
  // Coverage gaps must not silently shorten every protocol's history. The
  // common verified overlap is an explicit alternative to the full archive.
  const selectedMode = mode === 'verified' ? 'verified' : 'full';
  const rows = selectedMode === 'verified' ? verified : sourceGrain === 'day' ? history.map(comparisonDisplayDay) : history;
  return { mode: selectedMode, sourceGrain, grain: selectedMode === 'full' ? 'month' : sourceGrain, rows,
    fromDay: rows[0]?.fromDay || rows[0]?.day || null,
    throughDay: rows.at(-1)?.throughDay || rows.at(-1)?.day || null };
}

/** The table uses the same display observations as Full history, not exact-only months. */
export function comparisonDisplayMonths(daily = [], months = [], { now = Date.now(), fromDay = null, throughDay = null } = {}) {
  if (!daily.length) return months;
  const { rows } = selectComparisonView(daily, months, { mode: 'full' });
  return monthlyComparison(rows, { now, startDay: fromDay || rows[0].day,
    endDay: nextDay(throughDay || rows.at(-1).day) });
}

/** Summary counts follow the visible rows, including native monthly snapshots. */
export function comparisonViewAccounting(rows, { sourceGrain = 'day', correctedAccounting = true } = {}) {
  const points = rows.map(row => sourceGrain === 'day' ? row.thorchain : row.protocols?.thorchain);
  if (sourceGrain === 'day' && correctedAccounting) return comparisonAccountingSummary(points);
  let legacyDays = 0, correctedDays = 0;
  for (const point of points) {
    if (finite(point?.netUsd) === null) continue;
    const days = sourceGrain === 'day' ? 1 : finite(point.observedDays) ?? 1;
    if (!correctedAccounting) legacyDays += days;
    else if (finite(point.legacyDays) !== null && finite(point.correctedDays) !== null) {
      legacyDays += Number(point.legacyDays); correctedDays += Number(point.correctedDays);
    } else if (point.accounting === 'legacy') legacyDays += days;
    else correctedDays += days;
  }
  return { accounting: legacyDays ? correctedDays ? 'mixed' : 'legacy' : 'corrected', legacyDays, correctedDays };
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
        ...(id === 'thorchain' ? { ...comparisonAccountingSummary(rows.map(row => row[id])),
          ...Object.fromEntries(['grossIncomeUsd', 'revshareUsd', 'incomeUsd', 'subsidyUsd'].map(key => [key,
          rows.length === expectedDays && rows.every(row => finite(row[id]?.[key]) !== null)
            ? rows.reduce((total, row) => total + Number(row[id][key]), 0) : null
        ])) } : {}) }];
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
