import { getReadModel } from './read-models.js';
import {
  getSystemIncomePolState,
  loadSystemIncomePolDaily,
  loadSystemIncomePolPoolDaily,
  loadSystemIncomePolPositions
} from './system-income-pol-store.js';

export const SYSTEM_INCOME_POL_MODEL_KEY = 'system-income-pol:v1';
export const SYSTEM_INCOME_POL_SCHEMA_VERSION = 1;
export const SYSTEM_INCOME_POL_TTL_MS = 5 * 60 * 1000;

function integer(value, fallback = '0') {
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) ? normalized.replace(/^0+(?=\d)/, '') : fallback;
}

function add(...values) {
  return values.reduce((sum, value) => sum + BigInt(integer(value)), 0n).toString();
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

function publicPosition(row, estimatedFees, deployedE8) {
  return {
    asset: String(row.asset || ''),
    units_e8: integer(row.units_e8),
    total_pool_units_e8: integer(row.pool_units_e8),
    share_bps: shareBps(row.units_e8, row.pool_units_e8),
    rune_deposited_e8: deployedE8 == null ? integer(row.rune_deposited_e8) : integer(deployedE8),
    rune_held_e8: integer(row.rune_held_e8),
    asset_held_e8: integer(row.asset_held_e8),
    asset_price_rune: assetPriceRune(row.balance_rune_e8, row.balance_asset_e8),
    asset_value_rune_e8: integer(row.asset_value_rune_e8),
    position_value_rune_e8: integer(row.position_value_rune_e8),
    estimated_fees_e8: estimatedFees,
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

export async function buildSystemIncomePolReadModel(client, options = {}) {
  const nowValue = typeof options.now === 'function' ? options.now() : options.now;
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
  // The scheduler owns one advisory-lock client; serialize its queries so this
  // remains compatible with pg@9's single-query-per-client contract.
  const dailyRows = await (options.loadDaily || loadSystemIncomePolDaily)(client);
  const poolDailyRows = await (options.loadPoolDaily || loadSystemIncomePolPoolDaily)(client);
  const positionRows = await (options.loadPositions || loadSystemIncomePolPositions)(client);
  const state = await (options.loadState || getSystemIncomePolState)(client);
  const poolFees = new Map();
  const poolDeployments = new Map();
  for (const row of poolDailyRows) {
    poolDeployments.set(row.asset, add(poolDeployments.get(row.asset), row.deployed_e8));
    const current = poolFees.get(row.asset) || { total: '0', complete: true, rows: 0 };
    current.rows += 1;
    if (row.estimated_fees_e8 == null) current.complete = false;
    else current.total = add(current.total, row.estimated_fees_e8);
    poolFees.set(row.asset, current);
  }
  const pools = positionRows.map((row) => {
    const fees = poolFees.get(row.asset);
    const deployed = poolDeployments.get(row.asset);
    poolDeployments.delete(row.asset);
    return publicPosition(
      row,
      fees?.complete && fees.rows > 0 ? fees.total : null,
      deployed
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
      position_value_rune_e8: null,
      estimated_fees_e8: fees?.complete && fees.rows > 0 ? fees.total : null,
      rolling_liquidity_fee_rune_e8: null,
      status: 'reconciling',
      observed_height: null,
      observed_at: null,
      freshness: { positions_as_of: null, observed_height: null }
    });
  }
  const poolDailyByDay = new Map();
  for (const row of poolDailyRows) {
    const key = day(row.day);
    if (!key) continue;
    const current = poolDailyByDay.get(key) || { estimated: 0n, covered: 0, total: 0 };
    current.total += 1;
    if (row.estimated_fees_e8 != null) {
      current.estimated += BigInt(integer(row.estimated_fees_e8));
      current.covered += 1;
    }
    poolDailyByDay.set(key, current);
  }
  let cumulativeFunded = 0n;
  let cumulativeDeployed = 0n;
  let cumulativeFees = 0n;
  let feesComplete = true;
  const daily = dailyRows.map((row) => {
    const key = day(row.day);
    cumulativeFunded += BigInt(integer(row.funded_e8));
    cumulativeDeployed += BigInt(integer(row.deployed_e8));
    const fee = poolDailyByDay.get(key);
    const estimatedFees = fee?.total > 0 && fee.covered === fee.total
      ? fee.estimated.toString()
      : null;
    if (estimatedFees === null) feesComplete = false;
    else if (feesComplete) cumulativeFees += BigInt(estimatedFees);
    return {
      day: key,
      funded_e8: integer(row.funded_e8),
      deployed_e8: integer(row.deployed_e8),
      minted_units_e8: row.minted_units_e8 == null ? null : integer(row.minted_units_e8),
      estimated_fees_e8: estimatedFees,
      cumulative_funded_e8: cumulativeFunded.toString(),
      cumulative_deployed_e8: cumulativeDeployed.toString(),
      cumulative_estimated_fees_e8: feesComplete ? cumulativeFees.toString() : null,
      first_height: Number(row.first_height) || null,
      last_height: Number(row.last_height) || null,
      partial: Boolean(row.partial),
      fee_coverage: fee ? { covered_pools: fee.covered, total_pools: fee.total } : null
    };
  });
  const feeStates = [...poolFees.values()];
  const totalEstimatedFees = pools.length > 0
    && pools.every((pool) => pool.estimated_fees_e8 != null)
    && feeStates.every((fee) => fee.complete)
    ? add(...feeStates.map((fee) => fee.total))
    : null;
  const warnings = [];
  if (!state) warnings.push('SIPOL reconciliation is warming');
  if (state?.last_error) warnings.push(`SIPOL reconciliation: ${state.last_error}`);
  if (poolDailyRows.some((row) => row.estimated_fees_e8 == null)) {
    warnings.push('Some fee estimates are awaiting pre-block ownership coverage');
  }
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
    fee_pool_days: poolDailyRows.filter((row) => row.estimated_fees_e8 != null).length,
    fee_pool_days_total: poolDailyRows.length
  };
  return {
    payload: {
      schema_version: SYSTEM_INCOME_POL_SCHEMA_VERSION,
      as_of: generatedAt,
      module_address: String(state?.module_address || ''),
      activation_height: Number(state?.activation_height) || null,
      summary: {
        total_funded_e8: cumulativeFunded.toString(),
        total_deployed_e8: cumulativeDeployed.toString(),
        undeployed_rune_e8: state?.undeployed_rune_e8 == null
          ? null
          : integer(state.undeployed_rune_e8),
        total_position_value_rune_e8: add(...pools.map((row) => row.position_value_rune_e8)),
        total_rune_held_e8: add(...pools.map((row) => row.rune_held_e8)),
        total_asset_value_rune_e8: add(...pools.map((row) => row.asset_value_rune_e8)),
        total_estimated_fees_e8: totalEstimatedFees,
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
        { lane: 'positions', source: 'thornode-core:pools+thornode:pol_reserve-module-lp' },
        { lane: 'fees', source: 'pool_analysis_daily:liquidity-fees×time-weighted-share;deployment-days-unavailable' }
      ],
      warnings
    },
    generatedAt,
    sourceUpdatedAt: latestTime(eventsAsOf, positionsAsOf, feesAsOf),
    metadata: { warnings, partial: warnings.length > 0 },
    stats: { days: daily.length, pools: pools.length }
  };
}

export function applySystemIncomePolLiveOverlay(payload = {}, overlay = {}) {
  const reward = integer(overlay.reward_e8);
  const deployments = Array.isArray(overlay.deployments) ? overlay.deployments : [];
  const deployed = add(...deployments.map((row) => row.rune_e8));
  const summary = { ...(payload.summary || {}) };
  summary.total_funded_e8 = add(summary.total_funded_e8, reward);
  summary.total_deployed_e8 = add(summary.total_deployed_e8, deployed);
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
      deployed_e8: add(row.deployed_e8, deployed),
      cumulative_funded_e8: add(row.cumulative_funded_e8, reward),
      cumulative_deployed_e8: add(row.cumulative_deployed_e8, deployed),
      last_height: Number(overlay.through_height) || row.last_height,
      partial: true
    } : row
  ));
  if (overlayDay && !daily.some((row) => row.day === overlayDay)) {
    daily.push({
      day: overlayDay,
      funded_e8: reward,
      deployed_e8: deployed,
      minted_units_e8: null,
      estimated_fees_e8: null,
      cumulative_funded_e8: summary.total_funded_e8,
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
