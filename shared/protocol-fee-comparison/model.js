// Twelve complete UTC calendar months, plus the current partial month.
export function comparisonStartDay(now = Date.now()) {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 12, 1)).toISOString().slice(0, 10);
}
export const COMPARISON_MODEL_KEY = 'protocol-fee-comparison:v1';
export const COMPARISON_REFRESH_MS = 6 * 60 * 60_000;
export const DAY_MS = 86_400_000;
export const PROTOCOLS = Object.freeze([
  { id: 'thorchain', label: 'THORChain', color: '#00cc66' },
  { id: 'near', label: 'NEAR Intents', color: '#d4a017' },
  { id: 'chainflip', label: 'Chainflip', color: '#5588cc' }
]);

export const dayOf = (time) => new Date(time).toISOString().slice(0, 10);
export const dayTime = (day) => Date.parse(`${day}T00:00:00Z`);
export const nextDay = (day) => dayOf(dayTime(day) + DAY_MS);
export function calendarDays(start, endExclusive) {
  const days = [];
  for (let time = dayTime(start); time < dayTime(endExclusive); time += DAY_MS) days.push(dayOf(time));
  return days;
}

export function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function contribution(incomeUsd, subsidyUsd) {
  const income = finite(incomeUsd), subsidy = finite(subsidyUsd);
  return { incomeUsd: income, subsidyUsd: subsidy,
    netUsd: income === null || subsidy === null ? null : income - subsidy };
}

/** Never silently turn missing observations into a zero or a complete month. */
export function monthlyComparison(daily, { now = Date.now(), startDay = comparisonStartDay(now), endDay = dayOf(now) } = {}) {
  const index = new Map(daily.map((row) => [row.day, row]));
  const groups = new Map();
  for (const day of calendarDays(startDay, endDay)) {
    const month = day.slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(day);
  }
  return [...groups].map(([month, days]) => {
    const monthStart = `${month}-01`;
    const monthEnd = dayOf(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
    const partial = month === dayOf(now).slice(0, 7);
    const expectedDays = partial ? days.length : (dayTime(monthEnd) - dayTime(monthStart)) / DAY_MS;
    const calendarComplete = days[0] === monthStart && (partial || nextDay(days.at(-1)) === monthEnd);
    const protocols = Object.fromEntries(PROTOCOLS.map(({ id }) => {
      const observed = days.map((day) => index.get(day)?.[id]).filter((row) => finite(row?.netUsd) !== null);
      const complete = calendarComplete && observed.length === days.length;
      const sum = (key) => complete ? observed.reduce((total, row) => total + row[key], 0) : null;
      return [id, { incomeUsd: sum('incomeUsd'), subsidyUsd: sum('subsidyUsd'), netUsd: sum('netUsd'),
        observedDays: observed.length, expectedDays, complete }];
    }));
    return { month, partial, fromDay: days[0], throughDay: days.at(-1), expectedDays, protocols };
  });
}

export function hasComparisonData(payload) {
  return Boolean(payload?.months?.some((month) => PROTOCOLS.some(({ id }) => finite(month.protocols?.[id]?.netUsd) !== null)));
}

/** A cached month-to-date value must never become a completed historical month. */
export function ageComparisonPayload(payload, now = Date.now()) {
  const currentMonth = dayOf(now).slice(0, 7);
  const months = payload.months.map((month) => {
    if (!month.partial || month.month === currentMonth) return month;
    const start = `${month.month}-01`;
    const end = dayOf(Date.UTC(Number(month.month.slice(0, 4)), Number(month.month.slice(5, 7)), 1));
    if (month.fromDay === start && nextDay(month.throughDay) === end) return { ...month, partial: false };
    const expectedDays = (dayTime(end) - dayTime(start)) / DAY_MS;
    return { ...month, partial: false, expectedDays, protocols: Object.fromEntries(PROTOCOLS.map(({ id }) => [id,
      { ...month.protocols[id], incomeUsd: null, subsidyUsd: null, netUsd: null, expectedDays, complete: false }
    ])) };
  });
  return { ...payload, months, stale: Boolean(payload.stale || !payload.throughDay || nextDay(payload.throughDay) < dayOf(now)
    || !Number.isFinite(Date.parse(payload.asOf)) || now - Date.parse(payload.asOf) > COMPARISON_REFRESH_MS * 2) };
}

export function formatComparisonUsd(value, compact = false) {
  if (finite(value) === null) return 'Unavailable';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD',
    notation: compact ? 'compact' : 'standard', maximumFractionDigits: compact ? 1 : 0 }).format(value);
}

export function formatComparisonMonth(month) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
