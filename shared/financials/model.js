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

// Midgard's historical `blockRewards` is an accounting residual, not the
// protocol's Reserve emission amount. Preserve it only as source evidence.
export function signedIntegerAmount(value) {
  if (typeof value === 'string') return /^-?\d+$/.test(value) ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}

function amount(value, scale = 1e8) {
  const integer = integerAmount(value);
  return integer === null ? null : Number(integer) / scale;
}

function signedAmount(value, scale = 1e8) {
  const integer = signedIntegerAmount(value);
  return integer === null ? null : Number(integer) / scale;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// Independently observed payouts and protocol emissions must cover exactly the
// same UTC interval as the source earnings. Never manufacture either component
// from Midgard's residual, a current rate, a missing observation, or a clamp.
export function financialRewardBreakdown(income, evidence, { from, through }) {
  const covered = evidence?.complete === true && evidence.from === from && evidence.through === through
    && ['finalized-revshare-payouts', 'before-first-finalized-revshare-payout'].includes(evidence.method);
  const revshareE8 = covered ? integerAmount(evidence.revshareE8) : null;
  const emissionsE8 = covered && evidence.emissionsComplete === true
    && evidence.emissionsMethod === 'historical-reserve-formula-v1'
    ? integerAmount(evidence.reserveEmissionsE8) : null;
  const feesE8 = integerAmount(income?.liquidityFees);
  const earningsE8 = integerAmount(income?.earnings);
  const grossE8 = feesE8 !== null && emissionsE8 !== null ? BigInt(feesE8) + BigInt(emissionsE8) : null;
  const adjustmentE8 = grossE8 !== null && revshareE8 !== null && earningsE8 !== null
    ? BigInt(earningsE8) - (grossE8 - BigInt(revshareE8)) : null;
  const price = positive(income?.runePriceUSD);
  const grossIncomeRune = grossE8 === null ? null : Number(grossE8) / 1e8;
  return {
    reserveEmissionsRune: amount(emissionsE8),
    revshareRune: amount(revshareE8),
    grossIncomeRune,
    grossIncomeUsd: grossIncomeRune === null || price === null ? null : grossIncomeRune * price,
    reconciliationAdjustmentRune: adjustmentE8 === null ? null : Number(adjustmentE8) / 1e8,
    midgardResidualRune: signedAmount(income?.blockRewards),
    rewardAccounting: {
      complete: revshareE8 !== null && emissionsE8 !== null,
      revshareComplete: revshareE8 !== null,
      emissionsComplete: emissionsE8 !== null,
      method: evidence?.method ?? null,
      emissionsMethod: evidence?.emissionsMethod ?? null,
      from, through,
      observedBlocks: evidence?.observedBlocks ?? 0,
      expectedBlocks: evidence?.expectedBlocks ?? null
    }
  };
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

export function buildFinancialsPoints({ swaps = [], earnings = [], bonds = {}, rewardAccounting = {}, from, to }) {
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
      // Backward-compatible raw source field; new consumers use the explicit
      // components and must not label this residual as Reserve emissions.
      blockRewardsRune: signedAmount(income?.blockRewards),
      ...financialRewardBreakdown(income, rewardAccounting[day], { from: start, through: start + DAY_SECONDS }),
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

export function buildLiveFinancialsPoint({ from, through = from, swaps, earnings, bond, rewardAccounting }) {
  const day = utcDay(from);
  const interval = (row) => row ? [{ ...row, startTime: from, endTime: from + DAY_SECONDS }] : [];
  const point = buildFinancialsPoints({ from, to: from + DAY_SECONDS,
    swaps: interval(swaps), earnings: interval(earnings), bonds: { [day]: bond }
  })[0];
  return { ...point, partial: true, through, elapsedSeconds: through - from,
    ...financialRewardBreakdown(earnings, rewardAccounting, { from, through }),
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
