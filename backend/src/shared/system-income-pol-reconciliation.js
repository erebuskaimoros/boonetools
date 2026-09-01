import { config } from '../lib/config.js';
import { fetchThorchain } from './thornode.js';
import { coreSnapshotValue, getThorNodeCoreSnapshot } from './thornode-core-snapshot.js';
import { saveSystemIncomePolPositions } from './system-income-pol-store.js';

function integer(value, fallback = '0') {
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) ? BigInt(normalized) : BigInt(fallback);
}

function mimirBasisPoints(mimir, key) {
  const normalized = String(mimir?.[key] ?? '').trim();
  // POLReserveSystemIncomeBps defaults to zero in Thornode when no effective
  // Mimir is present, so mirror the protocol's resolved value here.
  return /^\d+$/.test(normalized) ? normalized : '0';
}

function timestamp(value) {
  const parsed = new Date(value || '');
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function thorHeight(lastblock) {
  const rows = Array.isArray(lastblock) ? lastblock : [];
  const thor = rows.find((row) => String(row?.chain || '').toUpperCase() === 'THOR');
  return Math.max(0, Math.trunc(Number(thor?.thorchain || rows[0]?.thorchain)) || 0);
}

function moduleRune(coins) {
  const row = (Array.isArray(coins) ? coins : []).find((coin) => (
    String(coin?.denom || '').toLowerCase() === 'rune'
  ));
  return integer(row?.amount).toString();
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, run));
  return results;
}

export function buildSystemIncomePolPositionRows(input = {}) {
  const moduleAddress = String(input.module?.address || '');
  const observedAt = timestamp(input.observedAt);
  const height = Math.max(1, Math.trunc(Number(input.height)) || 1);
  const providers = input.liquidityProviders instanceof Map
    ? input.liquidityProviders
    : new Map(Object.entries(input.liquidityProviders || {}));
  const positions = [];

  for (const pool of Array.isArray(input.pools) ? input.pools : []) {
    const asset = String(pool?.asset || '');
    if (!asset) continue;
    const lp = providers.get(asset) || {};
    const units = integer(lp.units);
    const deposited = integer(pool.pol_reserve_rune_deposited);
    if (units === 0n && deposited === 0n) continue;
    const poolUnits = integer(pool.pool_units);
    const balanceRune = integer(pool.balance_rune);
    const balanceAsset = integer(pool.balance_asset);
    const runeHeld = integer(lp.rune_redeem_value);
    const assetHeld = integer(lp.asset_redeem_value);
    const assetValueRune = balanceAsset > 0n
      ? (assetHeld * balanceRune) / balanceAsset
      : 0n;
    positions.push({
      asset,
      module_address: moduleAddress,
      units_e8: units.toString(),
      pool_units_e8: poolUnits.toString(),
      rune_deposited_e8: deposited.toString(),
      rune_held_e8: runeHeld.toString(),
      asset_held_e8: assetHeld.toString(),
      asset_value_rune_e8: assetValueRune.toString(),
      position_value_rune_e8: (runeHeld + assetValueRune).toString(),
      balance_rune_e8: balanceRune.toString(),
      balance_asset_e8: balanceAsset.toString(),
      asset_tor_price_e8: integer(pool.asset_tor_price).toString(),
      rolling_liquidity_fee_rune_e8: integer(pool.rolling_pool_liquidity_fee_rune).toString(),
      status: String(pool.status || ''),
      observed_height: height,
      observed_at: observedAt
    });
  }

  return {
    moduleAddress,
    undeployedRuneE8: moduleRune(input.module?.coins),
    positions
  };
}

export async function reconcileSystemIncomePolState(client, options = {}) {
  const getCore = options.getCoreSnapshot || getThorNodeCoreSnapshot;
  const fetchThor = options.fetchThorchain || fetchThorchain;
  const save = options.savePositions || saveSystemIncomePolPositions;
  const core = await getCore({ client, allowStale: true });
  const pools = coreSnapshotValue(core, 'pools', []);
  const lastblock = coreSnapshotValue(core, 'lastblock', []);
  const network = coreSnapshotValue(core, 'network', {});
  const mimir = coreSnapshotValue(core, 'mimir', {});
  if (!Array.isArray(pools)) throw new Error('SIPOL reconciliation requires thornode-core pools');
  const runePriceUsdE8 = integer(network?.rune_price_in_tor);
  const polReserveSystemIncomeBps = mimirBasisPoints(mimir, 'POLRESERVESYSTEMINCOMEBPS');
  if (runePriceUsdE8 <= 0n) throw new Error('SIPOL reconciliation requires a current THORNode RUNE price');
  const module = await fetchThor('/thorchain/balance/module/pol_reserve', {
    cooldownClient: client,
    timeoutMs: config.systemIncomePolTimeoutMs
  });
  if (!module?.address || !Array.isArray(module?.coins)) {
    throw new Error('SIPOL module balance response is invalid');
  }
  const activePools = pools.filter((pool) => integer(pool?.pol_reserve_rune_deposited) > 0n);
  const lpRows = await mapWithConcurrency(
    activePools,
    config.systemIncomePolLpConcurrency,
    async (pool) => {
      const endpoint = `/thorchain/pool/${encodeURIComponent(pool.asset)}/liquidity_provider/${module.address}`;
      try {
        return [pool.asset, await fetchThor(endpoint, {
          cooldownClient: client,
          timeoutMs: config.systemIncomePolTimeoutMs
        })];
      } catch (error) {
        if (Number(error?.status) === 404 || /404|not found/i.test(error?.message || '')) {
          return [pool.asset, { units: '0', rune_redeem_value: '0', asset_redeem_value: '0' }];
        }
        throw error;
      }
    }
  );
  const nowValue = typeof options.now === 'function' ? options.now() : options.now;
  const observedAt = nowValue || core?.payload?.field_meta?.pools?.fetched_at || new Date();
  const height = thorHeight(lastblock);
  if (height <= 0) throw new Error('SIPOL reconciliation requires a current THORChain height');
  const built = buildSystemIncomePolPositionRows({
    height,
    observedAt,
    module,
    pools: activePools,
    liquidityProviders: new Map(lpRows)
  });
  await save(client, built.positions, {
    activationHeight: config.systemIncomePolActivationHeight,
    moduleAddress: built.moduleAddress,
    undeployedRuneE8: built.undeployedRuneE8,
    runePriceUsdE8: runePriceUsdE8.toString(),
    polReserveSystemIncomeBps,
    observedAt: timestamp(observedAt),
    observedHeight: height
  });
  return {
    height,
    positions: built.positions.length,
    module_address: built.moduleAddress,
    undeployed_rune_e8: built.undeployedRuneE8,
    rune_price_usd_e8: runePriceUsdE8.toString(),
    pol_reserve_system_income_bps: Number(polReserveSystemIncomeBps)
  };
}
