const BILLION = 1_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HACK_HALT_ZERO_FEE_START = '2026-05-01';
const HACK_HALT_ZERO_FEE_END = '2026-07-01';
const HACK_HALT_LABEL = 'Chain halt';

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function compareWindow(left, right) {
  const leftTime = Date.parse(left.windowStart || '');
  const rightTime = Date.parse(right.windowStart || '');

  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return toFiniteNumber(left.sequence) - toFiniteNumber(right.sequence);
}

function parseUtcDate(value) {
  const parsed = new Date(`${String(value || '').slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function dateMs(value) {
  const parsed = parseUtcDate(value);
  return parsed ? parsed.getTime() : NaN;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateKeyValue, days) {
  const date = parseUtcDate(dateKeyValue);
  if (!date) return '';
  return dateKey(new Date(date.getTime() + days * DAY_MS));
}

function getWindowEndMs(row) {
  const explicitEndMs = dateMs(row?.windowEnd);
  if (Number.isFinite(explicitEndMs)) return explicitEndMs;

  const startMs = dateMs(row?.windowStart);
  return Number.isFinite(startMs) ? startMs + DAY_MS : NaN;
}

function lowerBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function weekKey(date) {
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return dateKey(new Date(date.getTime() + mondayOffset * DAY_MS));
}

function formatDayLabel(dateKeyValue) {
  const date = parseUtcDate(dateKeyValue);
  if (!date) return String(dateKeyValue || '');
  return `${MONTH_LABELS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function formatMonthLabel(key) {
  const [year, month] = String(key || '').split('-').map((part) => Number(part));
  if (!Number.isFinite(year) || !Number.isFinite(month)) return String(key || '');
  return `${MONTH_LABELS[Math.max(0, Math.min(11, month - 1))]} ${year}`;
}

function formatRangeLabel(startDate, endDate) {
  const start = parseUtcDate(startDate);
  const exclusiveEnd = parseUtcDate(endDate);
  if (!start || !exclusiveEnd) return String(startDate || '');

  const inclusiveEnd = new Date(exclusiveEnd.getTime() - DAY_MS);
  const sameMonth = start.getUTCMonth() === inclusiveEnd.getUTCMonth()
    && start.getUTCFullYear() === inclusiveEnd.getUTCFullYear();
  const sameYear = start.getUTCFullYear() === inclusiveEnd.getUTCFullYear();
  const startMonth = MONTH_LABELS[start.getUTCMonth()];
  const endMonth = MONTH_LABELS[inclusiveEnd.getUTCMonth()];

  if (dateKey(start) === dateKey(inclusiveEnd)) {
    return `${startMonth} ${start.getUTCDate()}, ${start.getUTCFullYear()}`;
  }

  if (sameMonth) {
    return `${startMonth} ${start.getUTCDate()}-${inclusiveEnd.getUTCDate()}, ${start.getUTCFullYear()}`;
  }

  if (sameYear) {
    return `${startMonth} ${start.getUTCDate()}-${endMonth} ${inclusiveEnd.getUTCDate()}, ${start.getUTCFullYear()}`;
  }

  return `${startMonth} ${start.getUTCDate()}, ${start.getUTCFullYear()}-${endMonth} ${inclusiveEnd.getUTCDate()}, ${inclusiveEnd.getUTCFullYear()}`;
}

export function computeFeesPerBillionUsd(tcFeesUsd, globalExchangeVolumeUsd) {
  const fees = toFiniteNumber(tcFeesUsd);
  const volume = toFiniteNumber(globalExchangeVolumeUsd);

  if (!(fees > 0) || !(volume > 0)) {
    return 0;
  }

  return (fees / volume) * BILLION;
}

function isHackHaltZeroFeeDay(row) {
  const startMs = dateMs(row.windowStart);
  return row.period === 'day' &&
    Number.isFinite(startMs) &&
    startMs >= dateMs(HACK_HALT_ZERO_FEE_START) &&
    startMs < dateMs(HACK_HALT_ZERO_FEE_END) &&
    !(toFiniteNumber(row.tcFeesUsd) > 0) &&
    toFiniteNumber(row.globalExchangeVolumeUsd) > 0;
}

export function normalizeTcFeeRows(rows = []) {
  return [...rows]
    .map((row, index) => {
      const tcFeesUsd = toFiniteNumber(row.tcFeesUsd);
      const globalExchangeVolumeUsd = toFiniteNumber(row.globalExchangeVolumeUsd);
      const computedFeesPerBillionUsd = computeFeesPerBillionUsd(
        tcFeesUsd,
        globalExchangeVolumeUsd
      );
      const normalizedBase = {
        sequence: toFiniteNumber(row.sequence, index + 1),
        period: String(row.period || ''),
        windowLabel: String(row.windowLabel || ''),
        windowStart: String(row.windowStart || ''),
        windowEnd: String(row.windowEnd || ''),
        feeBps: toFiniteNumber(row.feeBps),
        tcFeesRune: toFiniteNumber(row.tcFeesRune),
        runePriceUsd: toFiniteNumber(row.runePriceUsd),
        tcFeesUsd,
        cmcVolume24hUsd: toFiniteNumber(row.cmcVolume24hUsd),
        defillamaDexVolumeUsd: toFiniteNumber(row.defillamaDexVolumeUsd),
        globalExchangeVolumeUsd,
        feesPerBillionUsd: computedFeesPerBillionUsd,
        displayFeesPerBillionUsd: toFiniteNumber(
          row.displayFeesPerBillionUsd,
          computedFeesPerBillionUsd
        ),
        dailyMedianFeesPerBillionUsd: toFiniteNumber(row.dailyMedianFeesPerBillionUsd),
        dailyRangeLowFeesPerBillionUsd: toFiniteNumber(row.dailyRangeLowFeesPerBillionUsd),
        dailyRangeHighFeesPerBillionUsd: toFiniteNumber(row.dailyRangeHighFeesPerBillionUsd)
      };
      const rollingAverageExcluded = Boolean(row.rollingAverageExcluded) || isHackHaltZeroFeeDay(normalizedBase);
      const haltDayCount = toFiniteNumber(row.haltDayCount, rollingAverageExcluded ? 1 : 0);

      return {
        ...normalizedBase,
        rollingAverageExcluded,
        hasHaltDays: Boolean(row.hasHaltDays) || haltDayCount > 0,
        haltDayCount,
        haltLabel: rollingAverageExcluded || haltDayCount > 0 ? HACK_HALT_LABEL : ''
      };
    })
    .filter((row) => row.windowLabel && row.globalExchangeVolumeUsd > 0)
    .sort(compareWindow);
}

function buildHaltBands(rows = []) {
  const bands = [];
  let active = null;

  rows.forEach((row, index) => {
    if (row.hasHaltDays) {
      if (!active) {
        active = {
          startIndex: index,
          endIndex: index,
          label: row.haltLabel || HACK_HALT_LABEL
        };
      } else {
        active.endIndex = index;
      }
      return;
    }

    if (active) {
      bands.push(active);
      active = null;
    }
  });

  if (active) bands.push(active);
  return bands;
}

export function buildTcFeeChartSeries(rows = []) {
  const normalizedRows = normalizeTcFeeRows(rows);

  return {
    rows: normalizedRows,
    labels: normalizedRows.map((row) => row.windowLabel),
    feesPerBillionUsd: normalizedRows.map((row) => row.feesPerBillionUsd),
    feeBps: normalizedRows.map((row) => row.feeBps),
    dailyMedianFeesPerBillionUsd: normalizedRows.map((row) => row.dailyMedianFeesPerBillionUsd),
    dailyRangeLowFeesPerBillionUsd: normalizedRows.map((row) => row.dailyRangeLowFeesPerBillionUsd),
    dailyRangeHighFeesPerBillionUsd: normalizedRows.map((row) => row.dailyRangeHighFeesPerBillionUsd),
    haltBands: buildHaltBands(normalizedRows)
  };
}

export function aggregateTcFeeRows(rows = [], granularity = 'day') {
  const normalizedRows = normalizeTcFeeRows(rows);
  if (!normalizedRows.length || granularity === 'day') {
    return normalizedRows.map((row) => ({
      ...row,
      windowLabel: row.period === 'day' ? formatDayLabel(row.windowStart) : row.windowLabel
    }));
  }

  const groupMap = new Map();
  for (const row of normalizedRows) {
    const date = parseUtcDate(row.windowStart);
    if (!date) continue;

    const groupKey = granularity === 'month' ? monthKey(date) : weekKey(date);
    const existing = groupMap.get(groupKey) || {
      key: groupKey,
      rows: [],
      windowStart: granularity === 'month' ? `${groupKey}-01` : groupKey,
      windowEnd: ''
    };

    existing.rows.push(row);
    existing.windowEnd = row.windowEnd || addDays(row.windowStart, 1);
    groupMap.set(groupKey, existing);
  }

  return [...groupMap.values()]
    .sort((left, right) => Date.parse(`${left.windowStart}T00:00:00.000Z`) - Date.parse(`${right.windowStart}T00:00:00.000Z`))
    .map((group, index) => {
      const tcFeesRune = group.rows.reduce((sum, row) => sum + row.tcFeesRune, 0);
      const tcFeesUsd = group.rows.reduce((sum, row) => sum + row.tcFeesUsd, 0);
      const cmcVolume24hUsd = group.rows.reduce((sum, row) => sum + row.cmcVolume24hUsd, 0);
      const defillamaDexVolumeUsd = group.rows.reduce((sum, row) => sum + row.defillamaDexVolumeUsd, 0);
      const globalExchangeVolumeUsd = group.rows.reduce(
        (sum, row) => sum + row.globalExchangeVolumeUsd,
        0
      );
      const haltDayCount = group.rows.reduce((sum, row) => sum + row.haltDayCount, 0);

      return {
        sequence: index + 1,
        period: granularity,
        windowLabel: granularity === 'month'
          ? formatMonthLabel(group.key)
          : formatRangeLabel(group.windowStart, group.windowEnd),
        windowStart: group.windowStart,
        windowEnd: group.windowEnd,
        feeBps: 0,
        tcFeesRune,
        runePriceUsd: tcFeesRune > 0 ? tcFeesUsd / tcFeesRune : 0,
        tcFeesUsd,
        cmcVolume24hUsd,
        defillamaDexVolumeUsd,
        globalExchangeVolumeUsd,
        feesPerBillionUsd: computeFeesPerBillionUsd(tcFeesUsd, globalExchangeVolumeUsd),
        dailyMedianFeesPerBillionUsd: 0,
        dailyRangeLowFeesPerBillionUsd: 0,
        dailyRangeHighFeesPerBillionUsd: 0,
        rollingAverageExcluded: false,
        hasHaltDays: haltDayCount > 0,
        haltDayCount,
        haltLabel: haltDayCount > 0 ? HACK_HALT_LABEL : ''
      };
    });
}

export function buildRollingAverageSeries(sourceRows = [], targetRows = [], days = 30) {
  const normalizedSourceRows = normalizeTcFeeRows(sourceRows)
    .filter((row) => !row.rollingAverageExcluded)
    .map((row) => ({
      ...row,
      startMs: dateMs(row.windowStart)
    }))
    .filter((row) => Number.isFinite(row.startMs));
  const normalizedTargetRows = normalizeTcFeeRows(targetRows);
  const windowDays = Math.max(1, Math.trunc(Number(days) || 1));

  const sourceStartMs = normalizedSourceRows.map((row) => row.startMs);
  const feesPrefix = [0];
  const volumePrefix = [0];
  for (const row of normalizedSourceRows) {
    feesPrefix.push(feesPrefix.at(-1) + row.tcFeesUsd);
    volumePrefix.push(volumePrefix.at(-1) + row.globalExchangeVolumeUsd);
  }

  return normalizedTargetRows.map((targetRow) => {
    const endMs = getWindowEndMs(targetRow);
    if (!Number.isFinite(endMs)) return null;

    const startMs = endMs - windowDays * DAY_MS;
    const fromIndex = lowerBound(sourceStartMs, startMs);
    const toIndex = lowerBound(sourceStartMs, endMs);
    if (toIndex <= fromIndex) return null;

    const tcFeesUsd = feesPrefix[toIndex] - feesPrefix[fromIndex];
    const globalExchangeVolumeUsd = volumePrefix[toIndex] - volumePrefix[fromIndex];
    const value = computeFeesPerBillionUsd(tcFeesUsd, globalExchangeVolumeUsd);
    return value > 0 ? value : null;
  });
}

export function summarizeTcFeeRows(rows = []) {
  const normalizedRows = normalizeTcFeeRows(rows);
  if (!normalizedRows.length) {
    return {
      windowCount: 0,
      totalTcFeesUsd: 0,
      totalGlobalExchangeVolumeUsd: 0,
      weightedFeesPerBillionUsd: 0,
      latest: null,
      peak: null
    };
  }

  const totalTcFeesUsd = normalizedRows.reduce((sum, row) => sum + row.tcFeesUsd, 0);
  const totalGlobalExchangeVolumeUsd = normalizedRows.reduce(
    (sum, row) => sum + row.globalExchangeVolumeUsd,
    0
  );
  const peak = normalizedRows.reduce((best, row) => (
    row.feesPerBillionUsd > best.feesPerBillionUsd ? row : best
  ), normalizedRows[0]);

  return {
    windowCount: normalizedRows.length,
    totalTcFeesUsd,
    totalGlobalExchangeVolumeUsd,
    weightedFeesPerBillionUsd: computeFeesPerBillionUsd(
      totalTcFeesUsd,
      totalGlobalExchangeVolumeUsd
    ),
    latest: normalizedRows.at(-1),
    peak
  };
}
