const E8 = 100_000_000;

export const SYSTEM_INCOME_POL_RANGES = Object.freeze([
  { id: '30d', label: '30D', days: 30 },
  { id: '90d', label: '90D', days: 90 },
  { id: '180d', label: '180D', days: 180 },
  { id: 'all', label: 'ALL', days: null }
]);

const FEE_APR_WINDOWS = Object.freeze([
  { id: '24h', targetHours: 24 },
  { id: '7d', targetHours: 7 * 24 },
  { id: '30d', targetHours: 30 * 24 }
]);

function base(value, fallback = '0') {
  const normalized = String(value ?? '').trim();
  return /^-?\d+$/.test(normalized) ? BigInt(normalized).toString() : fallback;
}

function optionalBase(value) {
  if (value === null || value === undefined || value === '') return null;
  return base(value, null);
}

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function utcDay(value) {
  const normalized = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function addBase(...values) {
  return values.reduce((total, value) => total + BigInt(base(value)), 0n).toString();
}

function ratioBps(numerator, denominator) {
  const top = optionalBase(numerator);
  const bottom = optionalBase(denominator);
  if (top === null || bottom === null || BigInt(bottom) <= 0n) return null;
  return Number((BigInt(top) * 1_000_000n) / BigInt(bottom)) / 100;
}

function normalizeFeeAprWindows(source = {}) {
  const input = source && typeof source === 'object' ? source : {};
  return Object.fromEntries(FEE_APR_WINDOWS.map(({ id, targetHours }) => {
    const row = input[id] && typeof input[id] === 'object' ? input[id] : {};
    const aprBps = finite(row.estimated_fee_apr_bps ?? row.apr_bps);
    const normalizedTarget = Math.max(1, Math.trunc(finite(row.target_hours, targetHours)));
    const availableHours = Math.max(0, Math.trunc(finite(row.available_hours, 0)));
    const coveredHours = Math.max(0, Math.trunc(finite(row.covered_hours, 0)));
    const seededHours = Math.max(0, Math.trunc(finite(row.seeded_hours, 0)));
    const measuredHours = Math.max(
      0,
      Math.trunc(finite(row.measured_hours, coveredHours - seededHours))
    );
    const allowedStatuses = new Set(['unavailable', 'warming', 'partial', 'seeded', 'complete']);
    const status = allowedStatuses.has(String(row.status || ''))
      ? String(row.status)
      : (aprBps === null ? 'unavailable' : 'warming');
    return [id, {
      id,
      aprBps,
      aprPercent: aprBps === null ? null : aprBps / 100,
      feesE8: optionalBase(row.fees_e8),
      positionValueHoursE8: optionalBase(row.position_value_hours_e8),
      targetHours: normalizedTarget,
      availableHours,
      coveredHours,
      measuredHours,
      seededHours,
      status,
      complete: Boolean(row.complete) && status === 'complete'
    }];
  }));
}

export function e8ToNumber(value) {
  const normalized = optionalBase(value);
  return normalized === null ? null : Number(normalized) / E8;
}

function normalizeSummary(summary = {}) {
  const systemIncomePolShareBps = finite(summary.system_income_pol_share_bps);
  // Fall back to the historical share during a staggered backend/frontend
  // rollout; the explicit Mimir field always wins once the read model has it.
  const polReserveSystemIncomeBps = finite(
    summary.pol_reserve_system_income_bps ?? summary.system_income_pol_share_bps
  );
  const runeHeldSystemIncomeShareBps = finite(summary.rune_held_system_income_share_bps);
  return {
    totalFundedE8: base(summary.total_funded_e8 ?? summary.funded_rune_e8),
    totalSystemIncomeE8: optionalBase(summary.total_system_income_e8),
    systemIncomeSharePending: Boolean(summary.system_income_share_pending),
    systemIncomePolShareBps,
    systemIncomePolSharePercent: systemIncomePolShareBps === null ? null : systemIncomePolShareBps / 100,
    polReserveSystemIncomeBps,
    polReserveSystemIncomePercent: polReserveSystemIncomeBps === null
      ? null
      : polReserveSystemIncomeBps / 100,
    totalDeployedE8: base(summary.total_deployed_e8 ?? summary.deployed_rune_e8),
    undeployedRuneE8: optionalBase(summary.undeployed_rune_e8),
    totalPositionValueRuneE8: optionalBase(summary.total_position_value_rune_e8 ?? summary.position_rune_e8),
    totalPositionValueUsdE8: optionalBase(summary.total_position_value_usd_e8),
    totalRuneHeldE8: optionalBase(summary.total_rune_held_e8),
    totalRuneHeldUsdE8: optionalBase(summary.total_rune_held_usd_e8),
    runeHeldSystemIncomeShareBps,
    runeHeldSystemIncomeSharePercent: runeHeldSystemIncomeShareBps === null ? null : runeHeldSystemIncomeShareBps / 100,
    totalAssetValueRuneE8: optionalBase(summary.total_asset_value_rune_e8),
    totalAssetValueUsdE8: optionalBase(summary.total_asset_value_usd_e8),
    totalEstimatedFeesE8: optionalBase(summary.total_estimated_fees_e8 ?? summary.estimated_fees_rune_e8),
    totalEstimatedFeesUsdE8: optionalBase(summary.total_estimated_fees_usd_e8),
    runePriceUsdE8: optionalBase(summary.rune_price_usd_e8),
    feeEstimateComplete: Boolean(summary.fee_estimate_complete),
    feeHoursCovered: Math.max(0, Math.trunc(finite(summary.fee_hours_covered, 0))),
    feeHoursTotal: Math.max(0, Math.trunc(finite(summary.fee_hours_total, 0))),
    feeHoursSeeded: Math.max(0, Math.trunc(finite(summary.fee_hours_seeded, 0))),
    feeHoursProvisional: Math.max(0, Math.trunc(finite(summary.fee_hours_provisional, 0))),
    feeAprWindows: normalizeFeeAprWindows(summary.estimated_fee_apr ?? summary.fee_apr),
    activePoolCount: Math.max(0, Math.trunc(finite(summary.active_pool_count, 0))),
    totalFundedRune: e8ToNumber(summary.total_funded_e8 ?? summary.funded_rune_e8),
    totalDeployedRune: e8ToNumber(summary.total_deployed_e8 ?? summary.deployed_rune_e8),
    undeployedRune: e8ToNumber(summary.undeployed_rune_e8),
    totalPositionValueRune: e8ToNumber(summary.total_position_value_rune_e8 ?? summary.position_rune_e8),
    totalPositionValueUsd: e8ToNumber(summary.total_position_value_usd_e8),
    totalRuneHeld: e8ToNumber(summary.total_rune_held_e8),
    totalAssetValueRune: e8ToNumber(summary.total_asset_value_rune_e8),
    totalEstimatedFeesRune: e8ToNumber(summary.total_estimated_fees_e8 ?? summary.estimated_fees_rune_e8),
    totalEstimatedFeesUsd: e8ToNumber(summary.total_estimated_fees_usd_e8)
  };
}

function normalizePool(pool = {}) {
  const shareBps = finite(pool.share_bps ?? pool.ownership_bps);
  return {
    asset: String(pool.asset || ''),
    status: String(pool.status || ''),
    unitsE8: base(pool.units_e8 ?? pool.pol_units),
    totalPoolUnitsE8: optionalBase(pool.total_pool_units_e8 ?? pool.pool_units),
    shareBps,
    sharePercent: shareBps === null ? null : shareBps / 100,
    // Compare current depth with the remaining depth after removing POL's
    // proportional position. Full ownership leaves no finite comparison.
    depthIncreasePercent: shareBps !== null && shareBps >= 0 && shareBps < 10_000
      ? (shareBps / (10_000 - shareBps)) * 100
      : null,
    runeDepositedE8: base(pool.rune_deposited_e8 ?? pool.deposited_rune_e8),
    runeHeldE8: optionalBase(pool.rune_held_e8 ?? pool.rune_redeem_e8),
    assetHeldE8: optionalBase(pool.asset_held_e8 ?? pool.asset_redeem_e8),
    assetPriceRune: finite(pool.asset_price_rune),
    assetValueRuneE8: optionalBase(pool.asset_value_rune_e8),
    assetValueUsdE8: optionalBase(pool.asset_value_usd_e8),
    positionValueRuneE8: optionalBase(pool.position_value_rune_e8 ?? pool.position_rune_e8),
    positionValueUsdE8: optionalBase(pool.position_value_usd_e8),
    estimatedFeesE8: optionalBase(pool.estimated_fees_e8 ?? pool.estimated_fees_rune_e8),
    estimatedFeesUsdE8: optionalBase(pool.estimated_fees_usd_e8),
    feeEstimateComplete: Boolean(pool.fee_estimate_complete),
    feeHoursCovered: Math.max(0, Math.trunc(finite(pool.fee_hours_covered, 0))),
    feeHoursTotal: Math.max(0, Math.trunc(finite(pool.fee_hours_total, 0))),
    feeHoursSeeded: Math.max(0, Math.trunc(finite(pool.fee_hours_seeded, 0))),
    feeHoursProvisional: Math.max(0, Math.trunc(finite(pool.fee_hours_provisional, 0))),
    rollingLiquidityFeeRuneE8: optionalBase(pool.rolling_liquidity_fee_rune_e8),
    freshness: pool.freshness && typeof pool.freshness === 'object' ? pool.freshness : {}
  };
}

function normalizeDaily(row = {}) {
  const fundedE8 = optionalBase(row.funded_e8 ?? row.funded_rune_e8);
  const systemIncomeE8 = optionalBase(row.system_income_e8);
  const deployedE8 = optionalBase(row.deployed_e8 ?? row.deployed_rune_e8);
  const estimatedFeesE8 = optionalBase(row.estimated_fees_e8 ?? row.estimated_fees_rune_e8);
  const cumulativeFundedE8 = optionalBase(row.cumulative_funded_e8);
  const cumulativeSystemIncomeE8 = optionalBase(row.cumulative_system_income_e8);
  const cumulativeDeployedE8 = optionalBase(row.cumulative_deployed_e8);
  const cumulativeEstimatedFeesE8 = optionalBase(row.cumulative_estimated_fees_e8);
  const price = finite(row.rune_price_usd);
  const runePriceUsd = price > 0 ? price : null;
  const deployedRune = e8ToNumber(deployedE8);
  const estimatedFeesRune = e8ToNumber(estimatedFeesE8);
  return {
    day: utcDay(row.day),
    fundedE8,
    systemIncomeE8,
    deployedE8,
    estimatedFeesE8,
    cumulativeFundedE8,
    cumulativeSystemIncomeE8,
    cumulativeDeployedE8,
    cumulativeEstimatedFeesE8,
    cumulativeFundedRune: e8ToNumber(cumulativeFundedE8),
    cumulativeDeployedRune: e8ToNumber(cumulativeDeployedE8),
    cumulativeEstimatedFeesRune: e8ToNumber(cumulativeEstimatedFeesE8),
    fundedRune: e8ToNumber(fundedE8),
    deployedRune,
    runePriceUsd,
    priceSource: String(row.price_source || ''),
    priceProvisional: Boolean(row.price_provisional),
    deployedUsd: deployedRune === 0 ? 0
      : deployedRune !== null && runePriceUsd !== null ? deployedRune * runePriceUsd : null,
    estimatedFeesRune,
    estimatedFeesUsd: estimatedFeesRune === 0 ? 0
      : estimatedFeesRune !== null && runePriceUsd !== null ? estimatedFeesRune * runePriceUsd : null,
    feeCoverage: {
      coveredHours: Math.max(0, Math.trunc(finite(row.fee_coverage?.covered_hours, 0))),
      totalHours: Math.max(0, Math.trunc(finite(row.fee_coverage?.total_hours, 0))),
      seededHours: Math.max(0, Math.trunc(finite(row.fee_coverage?.seeded_hours, 0))),
      provisionalHours: Math.max(0, Math.trunc(finite(row.fee_coverage?.provisional_hours, 0)))
    },
    partial: Boolean(row.partial),
    coverage: row.coverage && typeof row.coverage === 'object' ? row.coverage : {}
  };
}

export function normalizeSystemIncomePolPayload(payload = {}) {
  const pools = (Array.isArray(payload.pools) ? payload.pools : [])
    .map(normalizePool)
    .filter((pool) => pool.asset)
    .sort((left, right) => (e8ToNumber(right.positionValueRuneE8) || 0) - (e8ToNumber(left.positionValueRuneE8) || 0));
  const daily = (Array.isArray(payload.daily) ? payload.daily : [])
    .map(normalizeDaily)
    .filter((row) => row.day)
    .sort((left, right) => left.day.localeCompare(right.day));
  // Accumulate dollars across the full history, before range filtering/zoom.
  // A missing price makes the all-time dollar total unknown, not understated.
  let cumulativeDeployedUsd = 0;
  let dollarHistoryComplete = true;
  for (const row of daily) {
    if (row.deployedUsd === null) dollarHistoryComplete = false;
    else cumulativeDeployedUsd += row.deployedUsd;
    row.cumulativeDeployedUsd = dollarHistoryComplete ? cumulativeDeployedUsd : null;
  }
  const liveHeight = Math.max(0, Math.trunc(finite(payload.live?.through_height, 0)));
  return {
    schemaVersion: finite(payload.schema_version, 1),
    asOf: timestamp(payload.as_of),
    moduleAddress: String(payload.module_address || ''),
    config: payload.config && typeof payload.config === 'object' ? payload.config : {},
    summary: normalizeSummary(payload.summary),
    pools,
    daily,
    coverage: payload.coverage && typeof payload.coverage === 'object' ? payload.coverage : {},
    freshness: payload.freshness && typeof payload.freshness === 'object' ? payload.freshness : {},
    liveHeight,
    liveTime: timestamp(payload.live?.through_time),
    stale: Boolean(payload.stale || payload.read_model?.stale),
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
    sources: Array.isArray(payload.sources) ? payload.sources : [],
    readModel: payload.read_model && typeof payload.read_model === 'object' ? payload.read_model : {}
  };
}

// The percentages may retain their last confirmed display value while the
// income denominator catches up. Never carry the old raw denominator (or any
// holdings/fees) into an incomplete replacement snapshot.
export function reconcileSystemIncomePolSnapshot(snapshot = {}, previous = {}) {
  const summary = { ...(snapshot.summary || {}) };
  const alreadyPending = Boolean(summary.system_income_share_pending);
  const pending = alreadyPending || optionalBase(summary.total_system_income_e8) === null;
  summary.system_income_share_pending = pending;
  if (pending) {
    summary.total_system_income_e8 = null;
    for (const key of ['system_income_pol_share_bps', 'rune_held_system_income_share_bps']) {
      summary[key] = finite(previous?.summary?.[key])
        ?? (alreadyPending ? finite(summary[key]) : null);
    }
  }
  return { ...snapshot, summary };
}

export function applySystemIncomePolHead(payload = {}, head = {}) {
  const height = Math.trunc(finite(head.height, 0));
  const throughHeight = Math.trunc(finite(payload.live?.through_height, 0));
  if (height <= throughHeight || height <= 0) return payload;

  const rewardE8 = base(head.pol_reserve_reward_e8);
  const systemIncomeE8 = optionalBase(head.system_income_e8);
  const deployments = (Array.isArray(head.pol_reserve_deployments) ? head.pol_reserve_deployments : [])
    .map((deployment) => ({
      asset: String(deployment?.asset || deployment?.pool || '').trim(),
      runeE8: base(deployment?.rune_e8 ?? deployment?.rune_amount_e8),
      unitsE8: optionalBase(deployment?.units_e8 ?? deployment?.minted_units_e8)
    }))
    .filter((deployment) => deployment.asset);
  const deployedE8 = addBase(...deployments.map((deployment) => deployment.runeE8));
  const summary = { ...(payload.summary || {}) };
  const priorIncomeE8 = optionalBase(summary.total_system_income_e8);
  const skippedHeight = height !== throughHeight + 1;
  const incomePending = Boolean(summary.system_income_share_pending)
    || priorIncomeE8 === null || systemIncomeE8 === null || skippedHeight;
  const confirmedPolShareBps = finite(summary.system_income_pol_share_bps)
    ?? ratioBps(summary.total_funded_e8 ?? summary.funded_rune_e8, priorIncomeE8);
  const confirmedRuneHeldShareBps = finite(summary.rune_held_system_income_share_bps)
    ?? ratioBps(summary.total_rune_held_e8, priorIncomeE8);
  summary.total_funded_e8 = addBase(summary.total_funded_e8 ?? summary.funded_rune_e8, rewardE8);
  summary.total_system_income_e8 = incomePending
    ? null
    : addBase(priorIncomeE8, systemIncomeE8);
  summary.system_income_share_pending = incomePending;
  summary.system_income_pol_share_bps = incomePending
    ? confirmedPolShareBps
    : ratioBps(summary.total_funded_e8, summary.total_system_income_e8);
  summary.rune_held_system_income_share_bps = incomePending
    ? confirmedRuneHeldShareBps
    : ratioBps(summary.total_rune_held_e8, summary.total_system_income_e8);
  summary.total_deployed_e8 = addBase(summary.total_deployed_e8 ?? summary.deployed_rune_e8, deployedE8);
  const pools = (Array.isArray(payload.pools) ? payload.pools : []).map((pool) => ({ ...pool }));
  for (const deployment of deployments) {
    let pool = pools.find((candidate) => String(candidate.asset) === deployment.asset);
    if (!pool) {
      pool = { asset: deployment.asset, status: 'reconciling', units_e8: null };
      pools.push(pool);
    }
    pool.rune_deposited_e8 = addBase(pool.rune_deposited_e8 ?? pool.deposited_rune_e8, deployment.runeE8);
  }

  const headTime = timestamp(head.time) || timestamp(payload.as_of);
  const day = utcDay(headTime);
  const daily = (Array.isArray(payload.daily) ? payload.daily : []).map((row) => ({ ...row }));
  if (day) {
    let row = daily.find((candidate) => utcDay(candidate.day) === day);
    if (!row) {
      row = { day, funded_e8: '0', system_income_e8: '0', deployed_e8: '0', estimated_fees_e8: null, partial: true };
      daily.push(row);
    }
    row.funded_e8 = addBase(row.funded_e8 ?? row.funded_rune_e8, rewardE8);
    row.system_income_e8 = optionalBase(row.system_income_e8) === null
      || systemIncomeE8 === null || skippedHeight
      ? null
      : addBase(row.system_income_e8, systemIncomeE8);
    row.deployed_e8 = addBase(row.deployed_e8 ?? row.deployed_rune_e8, deployedE8);
    if (row.cumulative_funded_e8 !== undefined && row.cumulative_funded_e8 !== null) {
      row.cumulative_funded_e8 = addBase(row.cumulative_funded_e8, rewardE8);
    }
    if (row.cumulative_system_income_e8 !== undefined && row.cumulative_system_income_e8 !== null) {
      row.cumulative_system_income_e8 = incomePending
        ? null
        : addBase(row.cumulative_system_income_e8, systemIncomeE8);
    }
    if (row.cumulative_deployed_e8 !== undefined && row.cumulative_deployed_e8 !== null) {
      row.cumulative_deployed_e8 = addBase(row.cumulative_deployed_e8, deployedE8);
    }
    row.partial = true;
  }

  return {
    ...payload,
    as_of: headTime || payload.as_of,
    summary,
    pools,
    daily,
    freshness: { ...(payload.freshness || {}), events_as_of: headTime || payload.freshness?.events_as_of },
    live: { ...(payload.live || {}), through_height: height, through_time: headTime || payload.live?.through_time }
  };
}

export function selectSystemIncomePolRange(rows = [], rangeId = '30d') {
  const range = SYSTEM_INCOME_POL_RANGES.find((candidate) => candidate.id === rangeId)
    || SYSTEM_INCOME_POL_RANGES[0];
  if (!range.days || rows.length <= range.days) return rows;
  return rows.slice(-range.days);
}

// Feature-owned values and provenance. No renderer coordinates or viewport math.
export function buildSystemIncomePolFeeChart(rows = [], options = {}) {
  const unit = options.unit === 'rune' ? 'rune' : 'usd';
  const points = rows.map((row) => {
    const rawValue = unit === 'usd' ? row.estimatedFeesUsd : row.estimatedFeesRune;
    const value = Number.isFinite(rawValue) && rawValue >= 0 ? rawValue : null;
    return {
      ...row,
      value,
      missingReason: value !== null ? '' : row.estimatedFeesRune == null
        ? 'Fee estimate unavailable' : 'Daily USD price unavailable',
      provisional: Boolean(row.partial || row.feeCoverage?.provisionalHours > 0
        || (unit === 'usd' && row.priceProvisional))
    };
  });
  return { unit, points, missingDays: points.filter(point => point.value === null).length };
}

// Run over the full history before range slicing so the RUNE fallback, like
// normalized cumulative historical dollars, stays anchored across range changes.
export function buildSystemIncomePolChart(rows = [], options = {}) {
  const unit = options.unit === 'usd' ? 'usd' : 'rune';
  const unitAvailable = unit === 'rune' || rows.some(row => Number.isFinite(row.deployedUsd));
  let cumulativeRunning = 0;
  const points = rows.map((row) => {
    const depositedPlotRune = Number.isFinite(row.deployedRune) ? Math.max(0, row.deployedRune) : 0;
    const cumulativeDepositedRune = Number.isFinite(row.cumulativeDeployedRune)
      ? Math.max(0, row.cumulativeDeployedRune)
      : cumulativeRunning + depositedPlotRune;
    cumulativeRunning = cumulativeDepositedRune;
    return {
      ...row,
      depositedPlotRune,
      cumulativeDepositedRune,
      depositedPlotValue: unit === 'usd' ? finite(row.deployedUsd) : depositedPlotRune,
      cumulativeDepositedValue: unit === 'usd' ? finite(row.cumulativeDeployedUsd) : cumulativeDepositedRune
    };
  });
  return {
    unit, unitAvailable, points,
    missingPriceDays: unit === 'usd' ? points.filter(point => point.depositedPlotValue === null).length : 0
  };
}

function formatE8(value, options = {}) {
  const number = e8ToNumber(value);
  if (number === null) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: options.compact ? 'compact' : 'standard',
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? 2
  }).format(number);
}

export function formatE8Rune(value, compact = false) {
  return formatE8(value, { compact, minimumFractionDigits: compact ? 0 : 2, maximumFractionDigits: 2 });
}

export function formatE8Asset(value) {
  return formatE8(value, { maximumFractionDigits: 6 });
}

export function formatE8Usd(value, compact = false) {
  const formatted = formatE8(value, {
    compact,
    minimumFractionDigits: compact ? 0 : 2,
    maximumFractionDigits: 2
  });
  return formatted === '—' ? formatted : `$${formatted}`;
}

export function buildSystemIncomePolAssetInventory(summary = {}, pools = []) {
  const inventory = [{
    asset: 'THOR.RUNE',
    ticker: 'RUNE',
    amountE8: summary.totalRuneHeldE8,
    valueUsdE8: summary.totalRuneHeldUsdE8
  }];
  for (const pool of pools) {
    if (pool.assetHeldE8 === null) continue;
    inventory.push({
      asset: pool.asset,
      ticker: String(pool.asset || '').split('.')[1]?.split('-')[0] || String(pool.asset || ''),
      amountE8: pool.assetHeldE8,
      valueUsdE8: pool.assetValueUsdE8
    });
  }
  return inventory;
}

export function formatPercent(value, fractionDigits) {
  if (!Number.isFinite(value)) return '—';
  const hasFixedPrecision = Number.isInteger(fractionDigits);
  const digits = hasFixedPrecision
    ? Math.max(0, Math.min(20, fractionDigits))
    : 4;
  return `${value.toLocaleString('en-US', {
    minimumFractionDigits: hasFixedPrecision ? digits : 0,
    maximumFractionDigits: digits
  })}%`;
}
