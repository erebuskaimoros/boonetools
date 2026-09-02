import { getReadModel } from './read-models.js';
import {
  getSystemIncomePolState,
  loadSystemIncomePolDaily,
  loadSystemIncomePolPoolDaily,
  loadSystemIncomePolPoolHourly,
  loadSystemIncomePolPositions
} from './system-income-pol-store.js';

export const SYSTEM_INCOME_POL_MODEL_KEY = 'system-income-pol:v1';
export const SYSTEM_INCOME_POL_SCHEMA_VERSION = 5;
export const SYSTEM_INCOME_POL_TTL_MS = 5 * 60 * 1000;

const FEE_APR_WINDOWS = Object.freeze([
  { id: '24h', hours: 24 },
  { id: '7d', hours: 7 * 24 },
  { id: '30d', hours: 30 * 24 }
]);
const HOUR_MS = 60 * 60 * 1000;

function integer(value, fallback = '0') {
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) ? normalized.replace(/^0+(?=\d)/, '') : fallback;
}

function add(...values) {
  return values.reduce((sum, value) => sum + BigInt(integer(value)), 0n).toString();
}

function multiplyE8(left, right) {
  if (left == null || right == null) return null;
  return ((BigInt(integer(left)) * BigInt(integer(right))) / 100_000_000n).toString();
}

function ratioBps(numerator, denominator) {
  if (numerator == null || denominator == null) return null;
  const divisor = BigInt(integer(denominator));
  if (divisor <= 0n) return null;
  return Number((BigInt(integer(numerator)) * 1_000_000n) / divisor) / 100;
}

function optionalNonnegativeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveDecimalString(value) {
  const normalized = typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' ? String(value) : '';
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? normalized : null;
}

function day(value) {
  const normalized = String(value || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  const parsed = new Date(value || '');
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
}

function iso(value) {
  const parsed = new Date(value || '');
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function latestTime(...values) {
  const times = values.map((value) => Date.parse(value || '')).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function shareBps(units, poolUnits) {
  const numerator = BigInt(integer(units));
  const denominator = BigInt(integer(poolUnits));
  if (denominator <= 0n) return null;
  return Number((numerator * 1_000_000n) / denominator) / 100;
}

function assetPriceRune(balanceRune, balanceAsset) {
  const rune = BigInt(integer(balanceRune));
  const asset = BigInt(integer(balanceAsset));
  if (asset <= 0n) return null;
  return Number((rune * 100_000_000n) / asset) / 1e8;
}

function publicPosition(row, fees, deployedE8, runePriceUsdE8) {
  const assetValueRuneE8 = integer(row.asset_value_rune_e8);
  const positionValueRuneE8 = integer(row.position_value_rune_e8);
  const runeHeldE8 = integer(row.rune_held_e8);
  const estimatedFeesE8 = fees?.rows > 0 && fees.covered > 0 ? fees.total : null;
  return {
    asset: String(row.asset || ''),
    units_e8: integer(row.units_e8),
    total_pool_units_e8: integer(row.pool_units_e8),
    share_bps: shareBps(row.units_e8, row.pool_units_e8),
    rune_deposited_e8: deployedE8 == null ? integer(row.rune_deposited_e8) : integer(deployedE8),
    rune_held_e8: runeHeldE8,
    rune_held_usd_e8: multiplyE8(runeHeldE8, runePriceUsdE8),
    asset_held_e8: integer(row.asset_held_e8),
    asset_price_rune: assetPriceRune(row.balance_rune_e8, row.balance_asset_e8),
    asset_value_rune_e8: assetValueRuneE8,
    asset_value_usd_e8: multiplyE8(assetValueRuneE8, runePriceUsdE8),
    position_value_rune_e8: positionValueRuneE8,
    position_value_usd_e8: multiplyE8(positionValueRuneE8, runePriceUsdE8),
    estimated_fees_e8: estimatedFeesE8,
    estimated_fees_usd_e8: multiplyE8(estimatedFeesE8, runePriceUsdE8),
    fee_estimate_complete: Boolean(fees?.complete && fees?.rows > 0),
    fee_hours_covered: fees?.covered || 0,
    fee_hours_total: fees?.rows || 0,
    fee_hours_seeded: fees?.seeded || 0,
    fee_hours_provisional: fees?.provisional || 0,
    rolling_liquidity_fee_rune_e8: integer(row.rolling_liquidity_fee_rune_e8),
    status: String(row.status || ''),
    observed_height: Number(row.observed_height) || null,
    observed_at: iso(row.observed_at),
    freshness: {
      positions_as_of: iso(row.observed_at),
      observed_height: Number(row.observed_height) || null
    }
  };
}

function annualizedAprBps(feesE8, positionValueHoursE8) {
  if (feesE8 <= 0n || positionValueHoursE8 <= 0n) return null;
  const hundredthBps = (
    feesE8 * 8_760n * 10_000n * 100n
  ) / positionValueHoursE8;
  return Number(hundredthBps) / 100;
}

export function buildSystemIncomePolAprWindows(poolHourlyRows = [], nowValue = new Date()) {
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
  const parsedNow = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const currentHour = Math.floor(parsedNow / HOUR_MS) * HOUR_MS;
  const grouped = new Map();

  for (const row of Array.isArray(poolHourlyRows) ? poolHourlyRows : []) {
    const parsedHour = Date.parse(row?.hour || '');
    if (!Number.isFinite(parsedHour)) continue;
    const hour = Math.floor(parsedHour / HOUR_MS) * HOUR_MS;
    if (hour >= currentHour) continue;
    const current = grouped.get(hour) || [];
    current.push(row);
    grouped.set(hour, current);
  }

  return Object.fromEntries(FEE_APR_WINDOWS.map(({ id, hours }) => {
    const cutoff = currentHour - hours * HOUR_MS;
    const hourGroups = [...grouped.entries()]
      .filter(([hour]) => hour >= cutoff)
      .sort(([left], [right]) => left - right)
      .map(([, rows]) => rows);
    const covered = hourGroups.filter((rows) => rows.length > 0 && rows.every((row) => (
      !row.provisional
      && row.estimated_fees_e8 != null
      && row.position_value_rune_e8 != null
      && BigInt(integer(row.position_value_rune_e8)) > 0n
    )));
    const fees = covered.reduce(
      (total, rows) => total + rows.reduce(
        (hourTotal, row) => hourTotal + BigInt(integer(row.estimated_fees_e8)),
        0n
      ),
      0n
    );
    const positionValueHours = covered.reduce(
      (total, rows) => total + rows.reduce(
        (hourTotal, row) => hourTotal + BigInt(integer(row.position_value_rune_e8)),
        0n
      ),
      0n
    );
    const seededHours = covered.filter((rows) => rows.some((row) => (
      row.position_value_seeded || row.fee_coverage === 'seeded'
    ))).length;
    const availableHours = hourGroups.length;
    const coveredHours = covered.length;
    const aprBps = annualizedAprBps(fees, positionValueHours);
    let status = 'complete';
    if (aprBps === null) status = 'unavailable';
    else if (availableHours < hours) status = 'warming';
    else if (coveredHours < availableHours) status = 'partial';
    else if (seededHours > 0) status = 'seeded';

    return [id, {
      estimated_fee_apr_bps: aprBps,
      fees_e8: fees.toString(),
      position_value_hours_e8: positionValueHours.toString(),
      target_hours: hours,
      available_hours: availableHours,
      covered_hours: coveredHours,
      measured_hours: Math.max(0, coveredHours - seededHours),
      seeded_hours: seededHours,
      status,
      complete: status === 'complete'
    }];
  }));
}

export async function buildSystemIncomePolReadModel(client, options = {}) {
  const nowValue = typeof options.now === 'function' ? options.now() : options.now;
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
  // The scheduler owns one advisory-lock client; serialize its queries so this
  // remains compatible with pg@9's single-query-per-client contract.
  const dailyRows = await (options.loadDaily || loadSystemIncomePolDaily)(client);
  const poolDailyRows = await (options.loadPoolDaily || loadSystemIncomePolPoolDaily)(client);
  const poolHourlyRows = await (options.loadPoolHourly || loadSystemIncomePolPoolHourly)(client);
  const positionRows = await (options.loadPositions || loadSystemIncomePolPositions)(client);
  const state = await (options.loadState || getSystemIncomePolState)(client);
  const runePriceUsdE8 = state?.rune_price_usd_e8 == null ? null : integer(state.rune_price_usd_e8);
  const feeAprWindows = buildSystemIncomePolAprWindows(poolHourlyRows, now);
  const poolFees = new Map();
  const poolDeployments = new Map();
  for (const row of poolDailyRows) {
    poolDeployments.set(row.asset, add(poolDeployments.get(row.asset), row.deployed_e8));
  }
  for (const row of poolHourlyRows) {
    const current = poolFees.get(row.asset) || {
      total: '0', complete: true, covered: 0, rows: 0, seeded: 0, provisional: 0
    };
    current.rows += 1;
    if (row.fee_coverage === 'seeded') current.seeded += 1;
    if (row.provisional) current.provisional += 1;
    if (row.estimated_fees_e8 == null) current.complete = false;
    else {
      current.total = add(current.total, row.estimated_fees_e8);
      current.covered += 1;
    }
    if (row.fee_coverage !== 'complete' || row.provisional) current.complete = false;
    poolFees.set(row.asset, current);
  }
  const pools = positionRows.map((row) => {
    const fees = poolFees.get(row.asset);
    const deployed = poolDeployments.get(row.asset);
    poolDeployments.delete(row.asset);
    return publicPosition(
      row,
      fees,
      deployed,
      runePriceUsdE8
    );
  });
  for (const [asset, deployedE8] of poolDeployments) {
    const fees = poolFees.get(asset);
    pools.push({
      asset,
      units_e8: null,
      total_pool_units_e8: null,
      share_bps: null,
      rune_deposited_e8: deployedE8,
      rune_held_e8: null,
      asset_held_e8: null,
      asset_price_rune: null,
      asset_value_rune_e8: null,
      asset_value_usd_e8: null,
      position_value_rune_e8: null,
      position_value_usd_e8: null,
      estimated_fees_e8: fees?.covered > 0 ? fees.total : null,
      estimated_fees_usd_e8: fees?.covered > 0 ? multiplyE8(fees.total, runePriceUsdE8) : null,
      fee_estimate_complete: Boolean(fees?.complete && fees?.rows > 0),
      fee_hours_covered: fees?.covered || 0,
      fee_hours_total: fees?.rows || 0,
      fee_hours_seeded: fees?.seeded || 0,
      fee_hours_provisional: fees?.provisional || 0,
      rolling_liquidity_fee_rune_e8: null,
      status: 'reconciling',
      observed_height: null,
      observed_at: null,
      freshness: { positions_as_of: null, observed_height: null }
    });
  }
  const poolHourlyByDay = new Map();
  for (const row of poolHourlyRows) {
    const key = day(row.hour);
    if (!key) continue;
    const current = poolHourlyByDay.get(key) || {
      estimated: 0n, covered: 0, total: 0, seeded: 0, provisional: 0
    };
    current.total += 1;
    if (row.fee_coverage === 'seeded') current.seeded += 1;
    if (row.provisional) current.provisional += 1;
    if (row.estimated_fees_e8 != null) {
      current.estimated += BigInt(integer(row.estimated_fees_e8));
      current.covered += 1;
    }
    poolHourlyByDay.set(key, current);
  }
  let cumulativeFunded = 0n;
  let cumulativeSystemIncome = 0n;
  let systemIncomeComplete = true;
  let cumulativeDeployed = 0n;
  let cumulativeFees = 0n;
  let feesComplete = true;
  const daily = dailyRows.map((row) => {
    const key = day(row.day);
    // Reuse the matching UTC day's stored Midgard interval-end price. Never
    // substitute the current position price or another day's reference.
    const dailyRunePriceUsd = positiveDecimalString(row.rune_price_usd);
    cumulativeFunded += BigInt(integer(row.funded_e8));
    if (row.system_income_e8 == null) systemIncomeComplete = false;
    else if (systemIncomeComplete) cumulativeSystemIncome += BigInt(integer(row.system_income_e8));
    cumulativeDeployed += BigInt(integer(row.deployed_e8));
    const fee = poolHourlyByDay.get(key);
    const estimatedFees = fee?.total > 0 && fee.covered === fee.total
      ? fee.estimated.toString()
      : null;
    if (estimatedFees === null) feesComplete = false;
    else if (feesComplete) cumulativeFees += BigInt(estimatedFees);
    return {
      day: key,
      funded_e8: integer(row.funded_e8),
      system_income_e8: row.system_income_e8 == null ? null : integer(row.system_income_e8),
      deployed_e8: integer(row.deployed_e8),
      rune_price_usd: dailyRunePriceUsd,
      price_source: dailyRunePriceUsd === null ? null : String(row.price_source || '') || null,
      price_provisional: Boolean(row.price_provisional) || key >= now.toISOString().slice(0, 10),
      price_as_of: dailyRunePriceUsd === null ? null : iso(row.price_as_of),
      price_updated_at: dailyRunePriceUsd === null ? null : iso(row.price_updated_at),
      minted_units_e8: row.minted_units_e8 == null ? null : integer(row.minted_units_e8),
      estimated_fees_e8: estimatedFees,
      cumulative_funded_e8: cumulativeFunded.toString(),
      cumulative_system_income_e8: systemIncomeComplete ? cumulativeSystemIncome.toString() : null,
      cumulative_deployed_e8: cumulativeDeployed.toString(),
      cumulative_estimated_fees_e8: feesComplete ? cumulativeFees.toString() : null,
      first_height: Number(row.first_height) || null,
      last_height: Number(row.last_height) || null,
      partial: Boolean(row.partial),
      fee_coverage: fee ? {
        covered_hours: fee.covered,
        total_hours: fee.total,
        seeded_hours: fee.seeded,
        provisional_hours: fee.provisional
      } : null
    };
  });
  const feeStates = [...poolFees.values()];
  const totalEstimatedFees = feeStates.some((fee) => fee.covered > 0)
    ? add(...feeStates.map((fee) => fee.total))
    : null;
  const feeEstimateComplete = pools.length > 0
    && pools.every((pool) => pool.fee_estimate_complete);
  const totalSystemIncome = systemIncomeComplete && dailyRows.length > 0
    ? cumulativeSystemIncome.toString()
    : null;
  const warnings = [];
  if (!state) warnings.push('SIPOL reconciliation is warming');
  if (state?.last_error) warnings.push(`SIPOL reconciliation: ${state.last_error}`);
  if (poolHourlyRows.some((row) => row.estimated_fees_e8 == null)) {
    warnings.push('Estimated fees exclude hours without an ownership seed');
  }
  if (!systemIncomeComplete) warnings.push('System income share is warming while legacy blocks are enriched');
  const generatedAt = now.toISOString();
  const eventsAsOf = iso(state?.events_updated_at);
  const positionsAsOf = iso(state?.positions_updated_at);
  const feesAsOf = iso(state?.fees_updated_at);
  const observedBlocks = dailyRows.reduce(
    (total, row) => total + Math.max(0, Number(row.observed_blocks) || 0),
    0
  );
  const expectedBlocks = dailyRows.reduce(
    (total, row) => total + Math.max(0, Number(row.expected_blocks) || 0),
    0
  );
  const coverage = {
    first_height: Number(dailyRows[0]?.first_height) || null,
    last_height: Number(dailyRows.at(-1)?.last_height) || null,
    observed_blocks: observedBlocks,
    missing_blocks: Math.max(0, expectedBlocks - observedBlocks),
    repaired_blocks: Math.max(0, Number(state?.stats_json?.repaired_blocks) || 0),
    position_pools: pools.length,
    through_day: daily.at(-1)?.day || null,
    fee_hours_covered: poolHourlyRows.filter((row) => row.estimated_fees_e8 != null).length,
    fee_hours_total: poolHourlyRows.length,
    fee_hours_seeded: poolHourlyRows.filter((row) => row.fee_coverage === 'seeded').length,
    fee_hours_provisional: poolHourlyRows.filter((row) => row.provisional).length
  };
  const totalPositionValueRuneE8 = add(...pools.map((row) => row.position_value_rune_e8));
  const totalRuneHeldE8 = add(...pools.map((row) => row.rune_held_e8));
  const totalAssetValueRuneE8 = add(...pools.map((row) => row.asset_value_rune_e8));
  return {
    payload: {
      schema_version: SYSTEM_INCOME_POL_SCHEMA_VERSION,
      as_of: generatedAt,
      module_address: String(state?.module_address || ''),
      activation_height: Number(state?.activation_height) || null,
      summary: {
        total_funded_e8: cumulativeFunded.toString(),
        total_system_income_e8: totalSystemIncome,
        system_income_pol_share_bps: ratioBps(cumulativeFunded.toString(), totalSystemIncome),
        pol_reserve_system_income_bps: optionalNonnegativeNumber(
          state?.stats_json?.pol_reserve_system_income_bps
        ),
        total_deployed_e8: cumulativeDeployed.toString(),
        undeployed_rune_e8: state?.undeployed_rune_e8 == null
          ? null
          : integer(state.undeployed_rune_e8),
        rune_price_usd_e8: runePriceUsdE8,
        total_position_value_rune_e8: totalPositionValueRuneE8,
        total_position_value_usd_e8: multiplyE8(totalPositionValueRuneE8, runePriceUsdE8),
        total_rune_held_e8: totalRuneHeldE8,
        total_rune_held_usd_e8: multiplyE8(totalRuneHeldE8, runePriceUsdE8),
        rune_held_system_income_share_bps: ratioBps(totalRuneHeldE8, totalSystemIncome),
        total_asset_value_rune_e8: totalAssetValueRuneE8,
        total_asset_value_usd_e8: multiplyE8(totalAssetValueRuneE8, runePriceUsdE8),
        total_estimated_fees_e8: totalEstimatedFees,
        total_estimated_fees_usd_e8: multiplyE8(totalEstimatedFees, runePriceUsdE8),
        fee_estimate_complete: feeEstimateComplete,
        fee_hours_covered: coverage.fee_hours_covered,
        fee_hours_total: coverage.fee_hours_total,
        fee_hours_seeded: coverage.fee_hours_seeded,
        fee_hours_provisional: coverage.fee_hours_provisional,
        estimated_fee_apr: feeAprWindows,
        active_pool_count: pools.filter((row) => BigInt(integer(row.units_e8)) > 0n).length
      },
      pools,
      daily,
      coverage,
      live: {
        through_height: Number(state?.last_event_height) || 0,
        through_time: eventsAsOf
      },
      freshness: {
        events_as_of: eventsAsOf,
        positions_as_of: positionsAsOf,
        fees_as_of: feesAsOf
      },
      sources: [
        { lane: 'events', source: 'thorchain-block-results:rewards,pol_reserve_deploy,add_liquidity,swap' },
        { lane: 'positions', source: 'thornode-core:pools+network-price+mimir+thornode:pol_reserve-module-lp' },
        { lane: 'daily_prices', source: 'system_income_burn_daily:liquify-midgard-earnings:interval-end-runePriceUSD' },
        { lane: 'fees', source: 'system-income-pol-block-fees:hourly×sampled-ownership' }
      ],
      warnings
    },
    generatedAt,
    sourceUpdatedAt: latestTime(eventsAsOf, positionsAsOf, feesAsOf),
    metadata: { warnings, partial: warnings.length > 0 },
    stats: { days: daily.length, pools: pools.length, feeHours: poolHourlyRows.length }
  };
}

export function applySystemIncomePolLiveOverlay(payload = {}, overlay = {}) {
  const reward = integer(overlay.reward_e8);
  const systemIncome = overlay.system_income_e8 == null ? null : integer(overlay.system_income_e8);
  const deployments = Array.isArray(overlay.deployments) ? overlay.deployments : [];
  const deployed = add(...deployments.map((row) => row.rune_e8));
  const summary = { ...(payload.summary || {}) };
  summary.total_funded_e8 = add(summary.total_funded_e8, reward);
  summary.total_deployed_e8 = add(summary.total_deployed_e8, deployed);
  summary.total_system_income_e8 = summary.total_system_income_e8 == null || systemIncome == null
    ? null
    : add(summary.total_system_income_e8, systemIncome);
  summary.system_income_pol_share_bps = ratioBps(
    summary.total_funded_e8,
    summary.total_system_income_e8
  );
  summary.rune_held_system_income_share_bps = ratioBps(
    summary.total_rune_held_e8,
    summary.total_system_income_e8
  );
  const byAsset = new Map(deployments.map((row) => [row.asset, row]));
  const pools = (Array.isArray(payload.pools) ? payload.pools : []).map((row) => {
    const delta = byAsset.get(row.asset);
    if (!delta) return row;
    byAsset.delete(row.asset);
    return {
      ...row,
      rune_deposited_e8: add(row.rune_deposited_e8, delta.rune_e8)
    };
  });
  for (const delta of byAsset.values()) {
    pools.push({
      asset: delta.asset,
      units_e8: null,
      total_pool_units_e8: null,
      share_bps: null,
      rune_deposited_e8: integer(delta.rune_e8),
      rune_held_e8: null,
      asset_held_e8: null,
      asset_value_rune_e8: null,
      position_value_rune_e8: null,
      estimated_fees_e8: null,
      status: 'reconciling'
    });
  }
  const throughTime = iso(overlay.through_time);
  const overlayDay = throughTime?.slice(0, 10);
  const daily = (Array.isArray(payload.daily) ? payload.daily : []).map((row) => (
    row.day === overlayDay ? {
      ...row,
      funded_e8: add(row.funded_e8, reward),
      system_income_e8: row.system_income_e8 == null || systemIncome == null
        ? null
        : add(row.system_income_e8, systemIncome),
      deployed_e8: add(row.deployed_e8, deployed),
      cumulative_funded_e8: add(row.cumulative_funded_e8, reward),
      cumulative_system_income_e8: row.cumulative_system_income_e8 == null || systemIncome == null
        ? null
        : add(row.cumulative_system_income_e8, systemIncome),
      cumulative_deployed_e8: add(row.cumulative_deployed_e8, deployed),
      last_height: Number(overlay.through_height) || row.last_height,
      partial: true
    } : row
  ));
  if (overlayDay && !daily.some((row) => row.day === overlayDay)) {
    daily.push({
      day: overlayDay,
      funded_e8: reward,
      system_income_e8: systemIncome,
      deployed_e8: deployed,
      rune_price_usd: null,
      price_source: null,
      price_provisional: true,
      price_as_of: null,
      price_updated_at: null,
      minted_units_e8: null,
      estimated_fees_e8: null,
      cumulative_funded_e8: summary.total_funded_e8,
      cumulative_system_income_e8: summary.total_system_income_e8,
      cumulative_deployed_e8: summary.total_deployed_e8,
      first_height: null,
      last_height: Number(overlay.through_height) || null,
      partial: true,
      fee_coverage: null
    });
  }
  return {
    ...payload,
    as_of: throughTime || payload.as_of,
    summary,
    pools,
    daily,
    freshness: {
      ...(payload.freshness || {}),
      events_as_of: throughTime || payload.freshness?.events_as_of || null
    },
    live: {
      through_height: Number(overlay.through_height) || payload.live?.through_height || 0,
      through_time: throughTime || payload.live?.through_time || null
    }
  };
}

export async function getSystemIncomePolReadModel(options = {}) {
  return getReadModel(SYSTEM_INCOME_POL_MODEL_KEY, { ...options, allowStale: true });
}
