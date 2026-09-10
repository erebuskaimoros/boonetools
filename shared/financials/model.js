export const DAY_SECONDS = 86_400;
// Multi-chain mainnet (including the original Chaosnet period).
export const FINANCIALS_START_DAY = '2021-04-13';
export const FINANCIALS_RANGES = Object.freeze([
  { id: '30d', label: '30D', days: 30 },
  { id: '90d', label: '90D', days: 90 },
  { id: '1y', label: '1Y', days: 365 },
  { id: 'all', label: 'ALL TIME', days: null }
]);

export function daySeconds(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error('Invalid UTC day');
  const seconds = Date.parse(`${day}T00:00:00Z`) / 1000;
  if (!Number.isFinite(seconds) || utcDay(seconds) !== day) throw new Error('Invalid UTC day');
  return seconds;
}

export function utcDay(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function financialsWindow(rangeId = '30d', now = Date.now()) {
  const range = FINANCIALS_RANGES.find((item) => item.id === rangeId);
  if (!range) throw new Error('Unknown Financials range');
  const to = Math.floor(now / 1000 / DAY_SECONDS) * DAY_SECONDS;
  const from = Math.max(daySeconds(FINANCIALS_START_DAY), range.days
    ? to - range.days * DAY_SECONDS : daySeconds(FINANCIALS_START_DAY));
  return { from, to, range: range.id };
}

export function integerAmount(value) {
  return /^\d+$/.test(String(value ?? '')) ? String(value) : null;
}

function amount(value, scale = 1e8) {
  const integer = integerAmount(value);
  return integer === null ? null : Number(integer) / scale;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function dailyBondingApr(rewardsE8, activeBondE8, elapsedSeconds = DAY_SECONDS) {
  const rewards = amount(rewardsE8);
  const bond = amount(activeBondE8);
  return rewards !== null && bond > 0 && elapsedSeconds > 0 && elapsedSeconds <= DAY_SECONDS
    ? rewards / bond * (DAY_SECONDS / elapsedSeconds) * 365 * 100 : null;
}

function indexIntervals(intervals, from, to) {
  return new Map(intervals.filter((row) => {
    const start = Number(row.startTime);
    return Number.isSafeInteger(start) && start % DAY_SECONDS === 0
      && start >= from && start < to && Number(row.endTime) === start + DAY_SECONDS;
  }).map((row) => [Number(row.startTime), row]));
}

export function buildFinancialsPoints({ swaps = [], earnings = [], bonds = {}, from, to }) {
  const swapDays = indexIntervals(swaps, from, to);
  const earningDays = indexIntervals(earnings, from, to);
  const points = [];
  for (let start = from; start < to; start += DAY_SECONDS) {
    const day = utcDay(start);
    const swap = swapDays.get(start);
    const income = earningDays.get(start);
    const bond = bonds[day];
    const runePriceUsd = positive(income?.runePriceUSD);
    const incomeRune = amount(income?.earnings);
    points.push({
      day,
      volumeRune: amount(swap?.totalVolume),
      // Midgard swap USD is denominated in cents, valued at execution time.
      volumeUsd: amount(swap?.totalVolumeUSD, 100),
      incomeRune,
      incomeUsd: incomeRune === null || runePriceUsd === null ? null : incomeRune * runePriceUsd,
      feesRune: amount(income?.liquidityFees),
      blockRewardsRune: amount(income?.blockRewards),
      bondingEarningsRune: amount(income?.bondingEarnings),
      activeBondRune: amount(bond?.activeBondE8),
      bondingApr: dailyBondingApr(income?.bondingEarnings, bond?.activeBondE8),
      runePriceUsd,
      bondHeight: bond?.height ?? null,
      bondTimestamp: bond?.timestamp ?? null
    });
  }
  return points;
}

export function buildLiveFinancialsPoint({ from, through = from, swaps, earnings, bond }) {
  const day = utcDay(from);
  const interval = (row) => row ? [{ ...row, startTime: from, endTime: from + DAY_SECONDS }] : [];
  const point = buildFinancialsPoints({ from, to: from + DAY_SECONDS,
    swaps: interval(swaps), earnings: interval(earnings), bonds: { [day]: bond }
  })[0];
  return { ...point, partial: true, through, elapsedSeconds: through - from,
    bondingApr: dailyBondingApr(earnings?.bondingEarnings, bond?.activeBondE8, through - from) };
}

export function appendFinancialsLivePoint(points, point, rangeId) {
  const range = FINANCIALS_RANGES.find((item) => item.id === rangeId);
  if (!range) throw new Error('Unknown Financials range');
  if (!point) return points;
  const merged = [...points.filter((row) => row.day < point.day), point];
  const earliest = range.days ? daySeconds(point.day) - (range.days - 1) * DAY_SECONDS : daySeconds(FINANCIALS_START_DAY);
  return merged.filter((row) => daySeconds(row.day) >= earliest);
}

function observedSum(points, field) {
  const values = points.map((row) => row[field]).filter((value) => value !== null && Number.isFinite(value));
  return { value: values.length ? values.reduce((total, value) => total + value, 0) : null, days: values.length };
}

export function summarizeFinancials(points, currency = 'usd') {
  const suffix = currency === 'rune' ? 'Rune' : 'Usd';
  const volume = observedSum(points, `volume${suffix}`);
  const income = observedSum(points, `income${suffix}`);
  const completed = points.filter((point) => !point.partial);
  const dailyIncome = observedSum(completed, `income${suffix}`);
  const apr = observedSum(completed, 'bondingApr');
  const latestApr = [...points].reverse().find((row) => row.bondingApr !== null);
  return {
    volume, income,
    averageDailyIncome: dailyIncome.days ? dailyIncome.value / dailyIncome.days : null,
    averageIncomeDays: dailyIncome.days,
    averageApr: apr.days ? apr.value / apr.days : null,
    averageAprDays: apr.days,
    aprDays: observedSum(points, 'bondingApr').days,
    completedDays: completed.length,
    latestApr: latestApr?.bondingApr ?? null,
    latestAprDay: latestApr?.day ?? null,
    days: points.length
  };
}

export function formatFinancialAmount(value, currency = 'usd', compact = true) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  /** @type {Intl.NumberFormatOptions} */
  const options = { maximumFractionDigits: 2, ...(compact ? { notation: 'compact' } : {}) };
  return currency === 'rune'
    ? `${new Intl.NumberFormat('en-US', options).format(value)} ᚱ`
    : new Intl.NumberFormat('en-US', { ...options, style: 'currency', currency: 'USD' }).format(value);
}

export function formatFinancialPercent(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? '—' : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)}%`;
}

export function formatFinancialDay(day) {
  return day ? new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
  }) : '—';
}
