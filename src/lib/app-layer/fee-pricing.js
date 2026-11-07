const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
  ? Number(value) : null;
const number = value => finite(value) ?? 0;
const DAY_MS = 86400000;

// Older cached responses represented a failed USD lookup as zero. Native fees
// are still recorded, so they distinguish an unpriced fee from a genuine zero.
export function normalizeGeneratedFeeRow(row) {
  const feeRune = number(row.liquidity_fee_rune);
  const feeUsd = finite(row.liquidity_fee_usd);
  const inferredUnpriced = !number(row.unpriced_events) && feeRune > 0
    && (feeUsd === null && row.unpriced_events === undefined || feeUsd === 0 && !(number(row.rune_price_usd) > 0));
  const unpricedEvents = Math.max(number(row.unpriced_events), inferredUnpriced ? number(row.swap_events) || 1 : 0);
  const unpricedRune = number(row.unpriced_fee_rune) || (inferredUnpriced ? feeRune : 0);
  const complete = row.pricing_complete !== false && !unpricedEvents && !row.fee_coverage_unknown && feeUsd !== null;
  return {
    ...row,
    liquidity_fee_usd: complete ? feeUsd : null,
    priced_fee_usd: finite(row.priced_fee_usd) ?? feeUsd ?? 0,
    unpriced_events: unpricedEvents,
    unpriced_fee_rune: unpricedRune,
    pricing_complete: complete,
    fee_coverage_unknown: Boolean(row.fee_coverage_unknown || feeUsd === null && !unpricedEvents),
    fee_coverage_tracked: true
  };
}

export function normalizeGeneratedFeeHistory(rows = [], stepDays = 1) {
  let previousDay;
  let cumulativeComplete = true;
  let historyIncomplete = false;
  let unpricedEvents = 0;
  let unpricedRune = 0;
  let pricedUsd = 0;
  return rows.map(normalizeGeneratedFeeRow).map(row => {
    const day = row.bucket_start || row.day_start || row.week_start;
    if (previousDay && Date.parse(day) - Date.parse(previousDay) > stepDays * DAY_MS) historyIncomplete = true;
    historyIncomplete ||= Boolean(row.history_incomplete || row.fee_coverage_unknown);
    cumulativeComplete &&= row.pricing_complete && row.cumulative_pricing_complete !== false && !historyIncomplete && row.cumulative_usd !== null;
    unpricedEvents += row.unpriced_events;
    unpricedRune += row.unpriced_fee_rune;
    pricedUsd += row.priced_fee_usd;
    previousDay = day;
    return {
      ...row,
      cumulative_usd: cumulativeComplete ? finite(row.cumulative_usd) : null,
      cumulative_priced_usd: finite(row.cumulative_priced_usd) ?? pricedUsd,
      cumulative_unpriced_events: finite(row.cumulative_unpriced_events) ?? unpricedEvents,
      cumulative_unpriced_fee_rune: finite(row.cumulative_unpriced_fee_rune) ?? unpricedRune,
      cumulative_pricing_complete: cumulativeComplete,
      history_incomplete: historyIncomplete
    };
  });
}

export function normalizeGeneratedFees(payload) {
  if (!payload) return null;
  const daily = normalizeGeneratedFeeHistory(payload.daily);
  const byDay = new Map(daily.map(row => [row.day_start, row]));
  const firstDay = daily[0]?.day_start;
  const lastDay = daily.at(-1)?.day_start;
  const weeklyInput = (payload.weekly || []).map(row => {
    let missing = false;
    const observations = [];
    for (let offset = 0; offset < 7 && firstDay; offset++) {
      const day = new Date(Date.parse(row.week_start) + offset * DAY_MS).toISOString().slice(0, 10);
      if (day >= firstDay && day <= lastDay && !byDay.has(day)) missing = true;
      if (byDay.has(day)) observations.push(byDay.get(day));
    }
    if (!observations.length) return missing ? { ...row, fee_coverage_unknown: true, pricing_complete: false } : row;
    const coverage = generatedFeeCoverage(observations);
    return {
      ...row,
      unpriced_events: Math.max(number(row.unpriced_events), coverage.unpricedEvents),
      unpriced_fee_rune: Math.max(number(row.unpriced_fee_rune), coverage.unpricedRune),
      priced_fee_usd: finite(row.priced_fee_usd) ?? coverage.pricedUsd,
      fee_coverage_unknown: missing,
      pricing_complete: row.pricing_complete !== false && !missing && observations.every(point => point.pricing_complete)
    };
  });
  const weekly = normalizeGeneratedFeeHistory(weeklyInput, 7);
  const rows = daily.length ? daily : weekly;
  const meta = payload.meta || {};
  const unpricedEvents = Math.max(number(meta.unpricedEventCount), rows.reduce((sum, row) => sum + row.unpriced_events, 0));
  const unpricedRune = Math.max(number(meta.unpricedFeeRune), rows.reduce((sum, row) => sum + row.unpriced_fee_rune, 0));
  const pricedUsd = finite(meta.pricedLiquidityFeeUsd) ?? rows.reduce((sum, row) => sum + row.priced_fee_usd, 0);
  const historyIncomplete = rows.some(row => row.history_incomplete);
  const pricingComplete = meta.pricingComplete !== false && !unpricedEvents && !historyIncomplete
    && rows.every(row => row.pricing_complete) && meta.totalLiquidityFeeUsd !== null;
  return {
    ...payload, daily, weekly,
    routes: (payload.routes || []).map(normalizeGeneratedFeeRow),
    pools: (payload.pools || []).map(normalizeGeneratedFeeRow),
    meta: {
      ...meta,
      unpricedEventCount: unpricedEvents,
      unpricedFeeRune: unpricedRune,
      pricedLiquidityFeeUsd: pricedUsd,
      pricingComplete,
      historyIncomplete,
      totalLiquidityFeeUsd: pricingComplete ? finite(meta.totalLiquidityFeeUsd) ?? rows.at(-1)?.cumulative_usd ?? 0 : null
    }
  };
}

export function generatedFeeCoverage(rows) {
  return rows.reduce((coverage, row) => ({
    unpricedEvents: coverage.unpricedEvents + number(row.unpriced_events),
    unpricedRune: coverage.unpricedRune + number(row.unpriced_fee_rune),
    pricedUsd: coverage.pricedUsd + number(row.priced_fee_usd),
    unknownBuckets: coverage.unknownBuckets + (row.fee_coverage_unknown ? 1 : 0)
  }), { unpricedEvents: 0, unpricedRune: 0, pricedUsd: 0, unknownBuckets: 0 });
}
