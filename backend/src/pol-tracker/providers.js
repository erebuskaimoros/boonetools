import { config } from '../lib/config.js';
import { fetchThorchain } from '../shared/thornode.js';
import { POL_TRACKER_TREASURY_MODULE } from '../../../shared/pol-tracker/model.js';

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
    && payload.pol && typeof payload.pol.value === 'string'
    && payload.reserve && typeof payload.reserve.value === 'string';
}

function validLiquidityPosition(payload) {
  return payload && typeof payload === 'object'
    && /^\d+$/.test(String(payload.units ?? ''))
    && /^\d+$/.test(String(payload.asset_redeem_value ?? ''))
    && /^\d+$/.test(String(payload.rune_redeem_value ?? ''));
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

  const [network, pools, runepoolResult] = await Promise.all([
    fetchHistorical('/thorchain/network'),
    fetchHistorical('/thorchain/pools'),
    fetchHistorical('/thorchain/runepool').then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error })
    )
  ]);
  if (!network || !/^\d+$/.test(String(network.rune_price_in_tor || ''))) {
    throw new Error(`Historical network response was invalid at height ${normalizedHeight}`);
  }
  if (!Array.isArray(pools)) {
    throw new Error(`Historical pools response was invalid at height ${normalizedHeight}`);
  }

  const moduleAddress = options.moduleAddress || POL_TRACKER_TREASURY_MODULE;
  const poolAssets = [...new Set(pools
    .map((pool) => String(pool?.asset || '').trim().toUpperCase())
    .filter((asset) => asset && !asset.startsWith('THOR.')))];
  const requestDelayMs = Math.max(0, Math.trunc(Number(
    options.requestDelayMs ?? config.polTrackerRequestDelayMs
  )) || 0);
  const results = await mapWithConcurrency(
    poolAssets,
    options.concurrency || config.polTrackerLpConcurrency,
    async (asset) => {
      try {
        const value = await fetchHistorical(
          `/thorchain/pool/${encodeURIComponent(asset)}/liquidity_provider/${moduleAddress}`
        );
        if (!validLiquidityPosition(value)) {
          throw new Error(`Historical Treasury LP response was invalid for ${asset}`);
        }
        await sleep(requestDelayMs);
        return { asset, value, error: null };
      } catch (error) {
        await sleep(requestDelayMs);
        // THORNode uses 404 for an address with no position in a pool.
        if (Number(error?.status) === 404) return { asset, value: null, error: null };
        return { asset, value: null, error };
      }
    }
  );

  const treasuryLps = new Map();
  const treasuryErrors = [];
  for (const result of results) {
    if (result.value) treasuryLps.set(result.asset, result.value);
    if (result.error) treasuryErrors.push({
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
    runepool: runepoolError ? null : runepoolResult.value,
    runepoolError,
    moduleAddress
  };
}
