import {
  getThorTreasuryAddresses,
  resolveTreasurySections
} from '../../../shared/treasury/config.js';
import {
  buildAssetPriceIndex,
  buildBondsByAddress,
  buildConsolidatedSection,
  buildThorHoldings,
  countUnpricedBalances,
  finalizeTreasuryEntry,
  fromBaseUnit,
  mergeDenomBalances,
  normalizeHoldings,
  safeNumber,
  summarizeSection,
  toTreasuryLpPosition,
  trackedEvmAssetsByChain
} from '../../../shared/treasury/model.js';
import {
  fetchExternalHoldings,
  fetchLiquidityProvider,
  fetchMemberPoolAssets,
  fetchTcyStaker,
  fetchThorBalance,
  fetchTokenPrices,
  fetchTreasuryCore,
  mapWithConcurrency
} from './providers.js';

export const TREASURY_SNAPSHOT_SCHEMA_VERSION = 2;
// The publisher runs every five minutes. Keep one missed-cycle of headroom so
// normal timer jitter/build duration does not mark a healthy snapshot stale.
export const TREASURY_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
export const TREASURY_LP_DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000;
export const TREASURY_LP_DISCOVERY_RETRY_MS = 60 * 60 * 1000;

const BALANCE_CONCURRENCY = 4;
const LP_DISCOVERY_CONCURRENCY = 3;
const LP_LOOKUP_CONCURRENCY = 6;

function errorMessage(error) {
  return error?.message || String(error || 'unknown error');
}

function entryKey(section, entry) {
  return `${section.key}:${entry.label}`;
}

function previousEntryMap(snapshot) {
  return new Map((snapshot?.sections || []).flatMap((section) =>
    (section.entries || []).map((entry) => [entryKey(section, entry), entry])
  ));
}

function priorControl(snapshot) {
  return snapshot?.control && typeof snapshot.control === 'object' ? snapshot.control : {};
}

function segmentResult(name, current, previous, validate, transform, warnings, states) {
  if (current?.ok && validate(current.value)) {
    states[name] = { status: 'fresh' };
    return transform(current.value);
  }
  if (previous != null && validate(previous)) {
    const detail = current?.error || `invalid ${name} response`;
    warnings.push(`${name}: ${detail}; reused last successful segment`);
    states[name] = { status: 'reused', warning: detail };
    return previous;
  }
  const detail = current?.error || `invalid ${name} response`;
  states[name] = { status: 'error', warning: detail };
  throw new Error(`Treasury ${name} segment unavailable: ${detail}`);
}

function runePriceFromNetwork(network) {
  return fromBaseUnit(network?.rune_price_in_tor);
}

function poolStateFromRows(pools, runePrice) {
  const availablePools = pools.filter((pool) => pool?.status === 'Available');
  return {
    availablePoolAssets: availablePools.map((pool) => pool.asset).filter(Boolean),
    assetPrices: buildAssetPriceIndex(availablePools, runePrice),
    trackedEvmAssetsByChain: trackedEvmAssetsByChain(availablePools)
  };
}

function repricePreviousHoldings(holdings = []) {
  return holdings.map((holding) => ({ ...holding, usdValue: null, hasMissingPrice: undefined }));
}

function applyTokenPrices(holdings, tokenPrices) {
  return holdings.map((holding) => {
    if (holding?.usdValue != null || !holding?.contractAddress) return holding;
    const key = `${holding.chain}:${String(holding.contractAddress).toLowerCase()}`;
    const price = safeNumber(tokenPrices[key]);
    return price > 0 ? { ...holding, usdValue: safeNumber(holding.amount) * price } : holding;
  });
}

function repriceLpPosition(position, assetPrices, runePrice) {
  const assetAmount = safeNumber(position?.assetAmount);
  const runeAmount = safeNumber(position?.runeAmount);
  const assetUsdValue = assetAmount * safeNumber(assetPrices[position?.fullPool]);
  const runeUsdValue = runeAmount * safeNumber(runePrice);
  return {
    ...position,
    assetAmount,
    runeAmount,
    assetUsdValue,
    runeUsdValue,
    totalUsdValue: assetUsdValue + runeUsdValue
  };
}

function isDiscoveryDue(record, nowMs) {
  const nextAttemptAt = Date.parse(record?.nextAttemptAt || '');
  if (Number.isFinite(nextAttemptAt) && nowMs < nextAttemptAt) return false;
  const discoveredAt = Date.parse(record?.discoveredAt || '');
  return !Number.isFinite(discoveredAt) || nowMs - discoveredAt >= TREASURY_LP_DISCOVERY_TTL_MS;
}

async function resolveLpDiscovery(entries, previousDiscovery, fallbackAssets, options, warnings, states) {
  const nowMs = options.nowMs;
  const nowIso = new Date(nowMs).toISOString();
  const resolved = {};
  await mapWithConcurrency(entries, LP_DISCOVERY_CONCURRENCY, async ({ entry, key }) => {
    const previous = previousDiscovery?.[key];
    if (!isDiscoveryDue(previous, nowMs)) {
      resolved[key] = previous;
      states[`lp-discovery:${key}`] = { status: 'reused', reason: 'not_due' };
      return;
    }

    try {
      const assets = await options.providers.fetchMemberPoolAssets(entry.address, options.providerOptions);
      resolved[key] = { assets, discoveredAt: nowIso };
      states[`lp-discovery:${key}`] = { status: 'fresh' };
    } catch (error) {
      const detail = errorMessage(error);
      if (previous?.assets) {
        resolved[key] = {
          ...previous,
          lastAttemptAt: nowIso,
          nextAttemptAt: new Date(nowMs + TREASURY_LP_DISCOVERY_RETRY_MS).toISOString()
        };
        warnings.push(`LP discovery ${entry.label}: ${detail}; reused last discovery`);
        states[`lp-discovery:${key}`] = { status: 'reused', warning: detail };
      } else {
        // A first-run broad scan is expensive but happens in the scheduled job,
        // never in a visitor request. Subsequent runs use the six-hour discovery.
        resolved[key] = { assets: fallbackAssets, discoveredAt: nowIso, broadFallback: true };
        warnings.push(`LP discovery ${entry.label}: ${detail}; used one-time pool scan`);
        states[`lp-discovery:${key}`] = { status: 'fallback', warning: detail };
      }
    }
  });
  return resolved;
}

async function loadLpPositions(entries, discovery, previousEntries, assetPrices, runePrice, options, warnings, states) {
  const jobs = entries.flatMap(({ section, entry, key }) =>
    (discovery[key]?.assets || []).map((asset) => ({ section, entry, key, asset }))
  );
  const results = await mapWithConcurrency(jobs, LP_LOOKUP_CONCURRENCY, async (job) => {
    try {
      const value = await options.providers.fetchLiquidityProvider(
        job.asset,
        job.entry.address,
        options.providerOptions
      );
      return { ...job, ok: true, value };
    } catch (error) {
      return { ...job, ok: false, error: errorMessage(error) };
    }
  });
  const byEntry = new Map(entries.map(({ key }) => [key, []]));
  const activeAssetsByEntry = new Map(entries.map(({ key }) => [key, new Set()]));

  for (const result of results) {
    const target = byEntry.get(result.key);
    if (result.ok) {
      states[`lp:${result.key}:${result.asset}`] = { status: 'fresh' };
      if (safeNumber(result.value?.units) <= 0) continue;
      activeAssetsByEntry.get(result.key).add(result.asset);
      const position = toTreasuryLpPosition(result.value, assetPrices, runePrice);
      if (position) target.push(position);
      continue;
    }

    const previous = previousEntries.get(result.key)?.lpPositions?.find(
      (position) => position.fullPool === result.asset
    );
    if (previous) {
      activeAssetsByEntry.get(result.key).add(result.asset);
      target.push(repriceLpPosition(previous, assetPrices, runePrice));
      warnings.push(`LP ${result.entry.label}/${result.asset}: ${result.error}; reused last position`);
      states[`lp:${result.key}:${result.asset}`] = { status: 'reused', warning: result.error };
    } else {
      warnings.push(`LP ${result.entry.label}/${result.asset}: ${result.error}`);
      states[`lp:${result.key}:${result.asset}`] = { status: 'error', warning: result.error };
    }
  }

  return { positionsByEntry: byEntry, activeAssetsByEntry };
}

function narrowBroadFallbackDiscovery(discovery, activeAssetsByEntry, previousEntries, nowIso) {
  return Object.fromEntries(Object.entries(discovery).map(([key, record]) => {
    if (!record?.broadFallback) return [key, record];
    const knownAssets = new Set([
      ...(activeAssetsByEntry.get(key) || []),
      ...((previousEntries.get(key)?.lpPositions || []).map((position) => position.fullPool))
    ]);
    return [key, {
      ...record,
      assets: [...knownAssets].filter(Boolean),
      discoveredAt: record.discoveredAt || nowIso,
      broadFallback: true,
      broadScanCompletedAt: record.broadScanCompletedAt || nowIso
    }];
  }));
}

function annotateSegmentWatermarks(states, previous, previousControl, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const previousObservedAt = previousControl.segmentObservedAt || {};
  const fallbackObservedAt = previous?.source_updated_at
    || previousControl.sourceUpdatedAt
    || previous?.as_of
    || null;
  const segmentObservedAt = {};

  for (const [key, state] of Object.entries(states)) {
    const observedAt = ['fresh', 'fallback'].includes(state.status)
      ? nowIso
      : previousObservedAt[key] || fallbackObservedAt;
    if (observedAt) {
      segmentObservedAt[key] = observedAt;
      state.observed_at = observedAt;
      const observedMs = Date.parse(observedAt);
      state.age_seconds = Number.isFinite(observedMs)
        ? Math.max(0, Math.floor((nowMs - observedMs) / 1000))
        : null;
    } else {
      state.observed_at = null;
      state.age_seconds = null;
    }
  }

  const substantiveFresh = Object.entries(states).some(([key, state]) => (
    state.status === 'fresh'
      && (
        ['network', 'pools', 'module', 'nodes'].includes(key)
        || key.startsWith('balances:')
        || key.startsWith('stakes:')
        || key.startsWith('lp:')
      )
  ));
  return {
    segmentObservedAt,
    sourceUpdatedAt: substantiveFresh ? nowIso : fallbackObservedAt || nowIso
  };
}

function countStates(states, status) {
  return Object.values(states).filter((state) => state.status === status).length;
}

export async function buildTreasurySnapshot(options = {}) {
  const now = typeof options.now === 'function' ? options.now() : new Date();
  const nowMs = now.getTime();
  const previous = options.previousSnapshot || null;
  const previousControl = priorControl(previous);
  const previousEntries = previousEntryMap(previous);
  const warnings = [];
  const segmentStates = {};
  const providers = {
    fetchExternalHoldings,
    fetchLiquidityProvider,
    fetchMemberPoolAssets,
    fetchTcyStaker,
    fetchThorBalance,
    fetchTokenPrices,
    fetchTreasuryCore,
    mapWithConcurrency,
    ...(options.providers || {})
  };
  const providerOptions = options.providerOptions || {};
  const core = await providers.fetchTreasuryCore(providerOptions);

  const runePrice = segmentResult(
    'network',
    core.network,
    previous?.runePrice,
    (value) => typeof value === 'number' ? value > 0 : runePriceFromNetwork(value) > 0,
    (value) => typeof value === 'number' ? value : runePriceFromNetwork(value),
    warnings,
    segmentStates
  );
  const poolState = segmentResult(
    'pools',
    core.pools,
    previousControl.poolState,
    (value) => Array.isArray(value)
      ? value.some((pool) => pool?.status === 'Available')
      : Array.isArray(value?.availablePoolAssets),
    (value) => Array.isArray(value) ? poolStateFromRows(value, runePrice) : value,
    warnings,
    segmentStates
  );
  // Always update the inherited RUNE price even when the pool list is reused.
  poolState.assetPrices = { ...(poolState.assetPrices || {}), 'THOR.RUNE': runePrice };
  const module = segmentResult(
    'module',
    core.module,
    previousControl.module,
    (value) => Boolean(value?.address) && Array.isArray(value?.coins),
    (value) => value,
    warnings,
    segmentStates
  );
  const resolvedSections = resolveTreasurySections(module);
  const thorAddresses = getThorTreasuryAddresses(resolvedSections);
  const bondsByAddress = segmentResult(
    'nodes',
    core.nodes,
    previousControl.bondsByAddress,
    (value) => Array.isArray(value)
      ? value.length > 0
      : Boolean(value) && typeof value === 'object',
    (value) => Array.isArray(value) ? buildBondsByAddress(value, thorAddresses) : value,
    warnings,
    segmentStates
  );

  const entries = resolvedSections.flatMap((section) => section.addresses.map((entry) => ({
    section,
    entry,
    key: entryKey(section, entry)
  })));
  const rawBalances = new Map();
  const rawStakedPositions = new Map();

  await providers.mapWithConcurrency(entries, BALANCE_CONCURRENCY, async ({ section, entry, key }) => {
    const oldEntry = previousEntries.get(key);
    try {
      if (entry.chain === 'THOR') {
        const bankBalances = await providers.fetchThorBalance(entry.address, providerOptions);
        rawBalances.set(key, buildThorHoldings(
          mergeDenomBalances(entry.moduleBalances, bankBalances),
          poolState.assetPrices
        ));
      } else {
        rawBalances.set(key, await providers.fetchExternalHoldings(
          entry,
          poolState.trackedEvmAssetsByChain,
          providerOptions
        ));
      }
      segmentStates[`balances:${key}`] = { status: 'fresh' };
    } catch (error) {
      const detail = errorMessage(error);
      if (oldEntry) {
        rawBalances.set(key, repricePreviousHoldings(oldEntry.balances));
        warnings.push(`Balances ${entry.label}: ${detail}; reused last successful balances`);
        segmentStates[`balances:${key}`] = { status: 'reused', warning: detail };
      } else if (entry.chain === 'THOR' && entry.moduleBalances?.length) {
        rawBalances.set(key, buildThorHoldings(entry.moduleBalances, poolState.assetPrices));
        warnings.push(`Balances ${entry.label}: ${detail}; used module balance response`);
        segmentStates[`balances:${key}`] = { status: 'fallback', warning: detail };
      } else {
        rawBalances.set(key, []);
        warnings.push(`Balances ${entry.label}: ${detail}`);
        segmentStates[`balances:${key}`] = { status: 'error', warning: detail };
      }
    }
  });

  const stakeEntries = entries.filter(({ entry }) => entry.includeTcyStake);
  await providers.mapWithConcurrency(stakeEntries, BALANCE_CONCURRENCY, async ({ entry, key }) => {
    const oldEntry = previousEntries.get(key);
    try {
      const staker = await providers.fetchTcyStaker(entry.address, providerOptions);
      rawStakedPositions.set(key, normalizeHoldings([{
        asset: 'THOR.TCY',
        chain: 'THOR',
        amount: fromBaseUnit(staker?.amount)
      }], poolState.assetPrices));
      segmentStates[`stakes:${key}`] = { status: 'fresh' };
    } catch (error) {
      const detail = errorMessage(error);
      if (oldEntry?.stakedPositions) {
        rawStakedPositions.set(key, normalizeHoldings(
          repricePreviousHoldings(oldEntry.stakedPositions),
          poolState.assetPrices
        ));
        warnings.push(`TCY stake ${entry.label}: ${detail}; reused last successful position`);
        segmentStates[`stakes:${key}`] = { status: 'reused', warning: detail };
      } else {
        rawStakedPositions.set(key, []);
        warnings.push(`TCY stake ${entry.label}: ${detail}`);
        segmentStates[`stakes:${key}`] = { status: 'error', warning: detail };
      }
    }
  });

  const allRawHoldings = [...rawBalances.values()].flat();
  let tokenPrices = previousControl.tokenPrices || {};
  try {
    tokenPrices = {
      ...tokenPrices,
      ...await providers.fetchTokenPrices(allRawHoldings, providerOptions)
    };
    segmentStates['token-prices'] = { status: 'fresh' };
  } catch (error) {
    const detail = errorMessage(error);
    warnings.push(`Token prices: ${detail}; reused last successful prices where available`);
    segmentStates['token-prices'] = { status: tokenPrices && Object.keys(tokenPrices).length ? 'reused' : 'error', warning: detail };
  }

  const thorEntries = entries.filter(({ entry }) => entry.chain === 'THOR');
  const lpDiscovery = await resolveLpDiscovery(
    thorEntries,
    previousControl.lpDiscovery,
    poolState.availablePoolAssets,
    { nowMs, providers, providerOptions },
    warnings,
    segmentStates
  );
  const lpResult = await loadLpPositions(
    thorEntries,
    lpDiscovery,
    previousEntries,
    poolState.assetPrices,
    runePrice,
    { providers, providerOptions },
    warnings,
    segmentStates
  );
  const normalizedLpDiscovery = narrowBroadFallbackDiscovery(
    lpDiscovery,
    lpResult.activeAssetsByEntry,
    previousEntries,
    now.toISOString()
  );

  const sectionPayloads = resolvedSections.map((section) => {
    const sectionEntries = section.addresses.map((entry) => {
      const key = entryKey(section, entry);
      const holdings = normalizeHoldings(
        applyTokenPrices(rawBalances.get(key) || [], tokenPrices),
        poolState.assetPrices
      );
      const balanceState = segmentStates[`balances:${key}`];
      return finalizeTreasuryEntry(entry, {
        balances: holdings,
        stakedPositions: rawStakedPositions.get(key) || [],
        lpPositions: lpResult.positionsByEntry.get(key) || [],
        bonds: bondsByAddress[String(entry.address).toLowerCase()] || [],
        runePrice,
        entryError: balanceState?.status === 'error' ? `Failed to load ${entry.label}.` : null
      });
    });
    return {
      key: section.key,
      title: section.title,
      description: section.description,
      entries: sectionEntries,
      summary: summarizeSection(sectionEntries)
    };
  });

  const consolidatedSection = buildConsolidatedSection(sectionPayloads);
  const totalSummary = summarizeSection(sectionPayloads.flatMap((section) => section.entries));
  const uniqueWarnings = [...new Set(warnings)];
  const usableEntries = sectionPayloads.flatMap((section) => section.entries)
    .filter((entry) => (
      entry.balances.length
      || entry.stakedPositions.length
      || entry.lpPositions.length
      || entry.bonds.length
    ));
  if (usableEntries.length === 0 && !previous) {
    throw new Error('Treasury snapshot produced no usable entries');
  }
  const watermarks = annotateSegmentWatermarks(
    segmentStates,
    previous,
    previousControl,
    nowMs
  );

  return {
    schema_version: TREASURY_SNAPSHOT_SCHEMA_VERSION,
    source: 'boonetools-backend',
    as_of: now.toISOString(),
    source_updated_at: watermarks.sourceUpdatedAt,
    runePrice,
    assetPrices: poolState.assetPrices,
    sections: sectionPayloads,
    consolidatedSection,
    totalSummary,
    unpricedBalanceCount: countUnpricedBalances(sectionPayloads),
    warnings: uniqueWarnings,
    partial: uniqueWarnings.length > 0,
    segment_health: {
      fresh: countStates(segmentStates, 'fresh'),
      reused: countStates(segmentStates, 'reused'),
      fallback: countStates(segmentStates, 'fallback'),
      errors: countStates(segmentStates, 'error'),
      segments: segmentStates
    },
    control: {
      module,
      poolState,
      bondsByAddress,
      tokenPrices,
      lpDiscovery: normalizedLpDiscovery,
      segmentObservedAt: watermarks.segmentObservedAt,
      sourceUpdatedAt: watermarks.sourceUpdatedAt
    }
  };
}
