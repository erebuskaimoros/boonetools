import { config } from '../lib/config.js';
import { fetchThorchain } from '../shared/thornode.js';
import {
  POL_TRACKER_RESERVE_MODULE,
  POL_TRACKER_TREASURY_MODULE
} from '../../../shared/pol-tracker/model.js';

function sleep(delayMs) {
  return delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
}

function historicalPath(endpoint, height) {
  const separator = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${separator}height=${Math.trunc(Number(height))}`;
}

async function mapWithConcurrency(values, concurrency, operation) {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(values.length, Math.max(1, concurrency)) },
    () => worker()
  ));
  return output;
}

function validRunepool(payload) {
  return payload && typeof payload === 'object'
    && payload.pol && typeof payload.pol.value === 'string';
}

function validLiquidityPosition(payload) {
  return payload && typeof payload === 'object'
    && /^\d+$/.test(String(payload.units ?? ''))
    && /^\d+$/.test(String(payload.asset_redeem_value ?? ''))
    && /^\d+$/.test(String(payload.rune_redeem_value ?? ''));
}

function positive(value) {
  return /^\d+$/.test(String(value ?? '')) && BigInt(value) > 0n;
}

export async function fetchHistoricalPolTrackerState(height, options = {}) {
  const normalizedHeight = Math.trunc(Number(height));
  if (!Number.isFinite(normalizedHeight) || normalizedHeight <= 0) {
    throw new Error(`Invalid POL Tracker height: ${height}`);
  }
  const fetchHistorical = options.fetchHistorical
    ? (endpoint) => options.fetchHistorical(historicalPath(endpoint, normalizedHeight), {
        height: normalizedHeight
      })
    : (endpoint) => fetchThorchain(historicalPath(endpoint, normalizedHeight), {
        historical: true,
        bases: options.thornodeUrls || config.polTrackerThornodeUrls,
        cooldownClient: options.client,
        cooldownScope: 'pol-tracker-history',
        sharedCooldown: true,
        timeoutMs: options.timeoutMs
      });

  const systemIncomePolActivationHeight = Math.max(1, Math.trunc(Number(
    options.systemIncomePolActivationHeight ?? config.systemIncomePolActivationHeight
  )) || 1);
  const systemIncomePolActive = normalizedHeight >= systemIncomePolActivationHeight;
  const [network, pools, runepoolResult, systemIncomeModuleResult] = await Promise.all([
    fetchHistorical('/thorchain/network'),
    fetchHistorical('/thorchain/pools'),
    fetchHistorical('/thorchain/runepool').then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error })
    ),
    systemIncomePolActive
      ? fetchHistorical('/thorchain/balance/module/pol_reserve').then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error })
        )
      : Promise.resolve({ value: null, error: null })
  ]);
  if (!network || !/^\d+$/.test(String(network.rune_price_in_tor || ''))) {
    throw new Error(`Historical network response was invalid at height ${normalizedHeight}`);
  }
  if (!Array.isArray(pools)) {
    throw new Error(`Historical pools response was invalid at height ${normalizedHeight}`);
  }

  const moduleAddress = options.moduleAddress || POL_TRACKER_TREASURY_MODULE;
  const reserveModuleAddress = options.reserveModuleAddress || POL_TRACKER_RESERVE_MODULE;
  const systemIncomePolModuleAddress = String(systemIncomeModuleResult.value?.address || '');
  const poolAssets = [...new Set(pools
    .map((pool) => String(pool?.asset || '').trim().toUpperCase())
    .filter((asset) => asset && !asset.startsWith('THOR.')))];
  const requestDelayMs = Math.max(0, Math.trunc(Number(
    options.requestDelayMs ?? config.polTrackerRequestDelayMs
  )) || 0);
  const positionRequests = poolAssets.flatMap((asset) => [
    { asset, owner: 'treasury', label: 'Treasury', address: moduleAddress },
    { asset, owner: 'reserve', label: 'Reserve POL', address: reserveModuleAddress }
  ]);
  if (systemIncomePolActive && systemIncomePolModuleAddress) {
    for (const pool of pools) {
      const asset = String(pool?.asset || '').trim().toUpperCase();
      if (!asset || asset.startsWith('THOR.') || !positive(pool?.pol_reserve_rune_deposited)) continue;
      positionRequests.push({
        asset,
        owner: 'system_income_pol',
        label: 'System Income POL',
        address: systemIncomePolModuleAddress
      });
    }
  }
  const results = await mapWithConcurrency(
    positionRequests,
    options.concurrency || config.polTrackerLpConcurrency,
    async ({ asset, owner, label, address }) => {
      try {
        const value = await fetchHistorical(
          `/thorchain/pool/${encodeURIComponent(asset)}/liquidity_provider/${address}`
        );
        if (!validLiquidityPosition(value)) {
          throw new Error(`Historical ${label} LP response was invalid for ${asset}`);
        }
        await sleep(requestDelayMs);
        return { asset, owner, value, error: null };
      } catch (error) {
        await sleep(requestDelayMs);
        // THORNode uses 404 for an address with no position in a pool.
        if (Number(error?.status) === 404) return { asset, owner, value: null, error: null };
        return { asset, owner, value: null, error };
      }
    }
  );

  const treasuryLps = new Map();
  const treasuryErrors = [];
  const reserveLps = new Map();
  const reserveErrors = [];
  const systemIncomePolLps = new Map();
  const systemIncomePolErrors = [];
  if (systemIncomePolActive && !systemIncomePolModuleAddress) {
    systemIncomePolErrors.push({
      asset: '',
      error: systemIncomeModuleResult.error?.message
        || String(systemIncomeModuleResult.error || 'Historical System Income POL module response was invalid')
    });
  }
  for (const result of results) {
    const positions = result.owner === 'reserve'
      ? reserveLps
      : result.owner === 'system_income_pol' ? systemIncomePolLps : treasuryLps;
    const errors = result.owner === 'reserve'
      ? reserveErrors
      : result.owner === 'system_income_pol' ? systemIncomePolErrors : treasuryErrors;
    if (result.value) positions.set(result.asset, result.value);
    if (result.error) errors.push({
      asset: result.asset,
      error: result.error?.message || String(result.error)
    });
  }

  const runepoolError = runepoolResult.error
    ? runepoolResult.error?.message || String(runepoolResult.error)
    : validRunepool(runepoolResult.value) ? '' : 'Historical RUNEPool response was invalid';

  return {
    network,
    pools,
    treasuryLps,
    treasuryErrors,
    reserveLps,
    reserveErrors,
    systemIncomePolActive,
    systemIncomePolModuleAddress,
    systemIncomePolLps,
    systemIncomePolErrors,
    runepool: runepoolError ? null : runepoolResult.value,
    runepoolError,
    moduleAddress,
    reserveModuleAddress
  };
}
