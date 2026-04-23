import { getClient, query } from '../db/pool.js';
import { upsertRows } from '../db/sql.js';
import { error, isValidThorAddress, json } from '../lib/http.js';
import {
  calculateBondHistoryRow,
  hasBondHistoryValue,
  isPoisonedBondHistoryRow,
  isTransientHistoricalFetchError
} from '../shared/bond-history.js';
import { fetchMidgardActions } from '../shared/midgard.js';
import { fetchStockPrices } from '../shared/stock-prices.js';
import { fetchChurns, fetchNodes, fetchThorchain } from '../shared/thornode.js';

const BOND_HISTORY_SCOPE_CURRENT = 'current';
const BOND_HISTORY_SCOPE_HISTORICAL = 'historical';
const BOND_HISTORY_SCOPE_LEGACY = 'legacy';

async function fetchNodeAtHeight(nodeAddress, height) {
  return fetchThorchain(`/thorchain/node/${nodeAddress}?height=${height}`, { historical: true });
}

async function fetchNetworkAtHeight(height) {
  return fetchThorchain(`/thorchain/network?height=${height}`, { historical: true });
}

async function getCurrentNodeAddresses(bondAddress) {
  const target = String(bondAddress || '').toLowerCase();
  const nodes = await fetchNodes();
  const nodeAddresses = [];

  for (const node of nodes || []) {
    const provider = (node?.bond_providers?.providers || []).find((candidate) => (
      String(candidate?.bond_address || '').toLowerCase() === target
    ));
    if (provider && Number(provider.bond || 0) > 1e8 && node?.node_address) {
      nodeAddresses.push(String(node.node_address));
    }
  }

  return nodeAddresses;
}

async function getAllNodeAddresses(bondAddress) {
  const currentNodes = await getCurrentNodeAddresses(bondAddress);
  const currentSet = new Set(currentNodes);
  const nodeSet = new Set(currentNodes);
  let earliestCurrentBondHeight = Infinity;
  let discoveryComplete = true;
  let discoveryError = '';

  try {
    let offset = 0;
    const limit = 50;
    let hasMore = true;

    while (hasMore) {
      const data = await fetchMidgardActions({
        address: bondAddress,
        type: 'bond',
        limit,
        offset
      });
      const actions = data.actions || [];
      for (const action of actions) {
        const nodeAddress = action.metadata?.bond?.nodeAddress;
        if (!nodeAddress || !nodeAddress.startsWith('thor1')) {
          continue;
        }

        nodeSet.add(nodeAddress);
        if (currentSet.has(nodeAddress)) {
          const height = Number(action.height);
          if (height > 0 && height < earliestCurrentBondHeight) {
            earliestCurrentBondHeight = height;
          }
        }
      }

      if (actions.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }
  } catch (scanError) {
    discoveryComplete = false;
    discoveryError = scanError.message || 'Unable to discover historical bond nodes';
    console.warn(`[bond-history] degraded node discovery for ${bondAddress}: ${discoveryError}`);
  }

  return {
    current: currentNodes,
    all: Array.from(nodeSet),
    currentNodesSinceHeight: earliestCurrentBondHeight === Infinity ? 0 : earliestCurrentBondHeight,
    discoveryComplete,
    discoveryError
  };
}

async function fetchRatesJson() {
  try {
    const [fiatResponse, cryptoResponse, stockResponse] = await Promise.allSettled([
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=thorchain&vs_currencies=eur,gbp,jpy,btc,xau'),
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero,zcash&vs_currencies=usd'),
      fetchStockPrices(['SPY', 'VT', 'GC=F'])
    ]);

    const rates = {};

    if (fiatResponse.status === 'fulfilled' && fiatResponse.value.ok) {
      const data = await fiatResponse.value.json();
      const thorchain = data?.thorchain;
      if (thorchain?.eur) rates.EUR = thorchain.eur;
      if (thorchain?.gbp) rates.GBP = thorchain.gbp;
      if (thorchain?.jpy) rates.JPY = thorchain.jpy;
      if (thorchain?.btc) rates.BTC = thorchain.btc;
      if (thorchain?.xau) rates.XAU = thorchain.xau;
    }

    if (cryptoResponse.status === 'fulfilled' && cryptoResponse.value.ok) {
      const data = await cryptoResponse.value.json();
      if (data?.monero?.usd) rates.XMR_USD = data.monero.usd;
      if (data?.zcash?.usd) rates.ZEC_USD = data.zcash.usd;
    }

    if (stockResponse.status === 'fulfilled') {
      const stockData = stockResponse.value.prices;
      if (stockData.SPY) rates.SPY_USD = stockData.SPY;
      if (stockData.VT) rates.VT_USD = stockData.VT;
      if (stockData['GC=F'] && !rates.XAU) rates.XAU_USD = stockData['GC=F'];
    }

    return Object.keys(rates).length > 0 ? rates : null;
  } catch {
    return null;
  }
}

function normalizeHistoryRows(rows) {
  return (rows || []).map((row) => ({
    churn_height: Number(row.churn_height),
    churn_timestamp: Number(row.churn_timestamp),
    rune_stack: Number(row.rune_stack),
    user_bond: row.user_bond == null ? null : Number(row.user_bond),
    rune_price: Number(row.rune_price),
    rates_json: row.rates_json || null
  }));
}

function getHistoryScope(includeHistorical) {
  return includeHistorical ? BOND_HISTORY_SCOPE_HISTORICAL : BOND_HISTORY_SCOPE_CURRENT;
}

function earliestPositiveHeight(rows) {
  const heights = (rows || [])
    .filter((row) => Number(row.rune_stack) > 0)
    .map((row) => Number(row.churn_height))
    .filter((height) => Number.isFinite(height) && height > 0);

  return heights.length > 0 ? Math.min(...heights) : 0;
}

function inferHasHistoricalFromCache({
  discoveredHasHistorical,
  currentRows,
  historicalRows,
  legacyRows
}) {
  if (discoveredHasHistorical) {
    return true;
  }

  const currentFirstHeight = earliestPositiveHeight(currentRows);
  if (currentFirstHeight <= 0) {
    return false;
  }

  return [historicalRows, legacyRows].some((rows) => {
    const firstHeight = earliestPositiveHeight(rows);
    return firstHeight > 0 && firstHeight < currentFirstHeight;
  });
}

function filterCachedHistoryRows(rows, minHeight) {
  return (rows || []).filter((row) => (
    Number(row.rune_stack) > 0 && Number(row.churn_height) >= minHeight
  ));
}

function cachedHistoryResponse({
  bondAddress,
  cachedRows,
  hasHistorical,
  minHeight,
  stale = false,
  warning = ''
}) {
  const filtered = filterCachedHistoryRows(cachedRows, minHeight);
  const payload = {
    bond_address: bondAddress,
    history: normalizeHistoryRows(filtered),
    has_historical: hasHistorical,
    fetched: 0,
    total: filtered.length
  };

  if (stale) {
    payload.stale = true;
  }
  if (warning) {
    payload.warning = warning;
  }

  return json(payload, 200, {
    'Cache-Control': stale ? 'public, max-age=15' : 'public, max-age=30'
  });
}

async function processChurn(bondAddress, nodeAddresses, churnHeight, churnTimestamp, ratesJson) {
  const nodePromises = nodeAddresses.map(async (address) => {
    try {
      return {
        ok: true,
        data: await fetchNodeAtHeight(address, churnHeight - 1)
      };
    } catch (fetchError) {
      return {
        ok: false,
        data: null,
        error: fetchError
      };
    }
  });
  const networkPromise = fetchNetworkAtHeight(churnHeight)
    .then((data) => ({ ok: true, data }))
    .catch((fetchError) => ({
      ok: false,
      data: null,
      error: fetchError
    }));

  const [nodeResults, networkData] = await Promise.all([
    Promise.all(nodePromises),
    networkPromise
  ]);

  const hasTransientNodeFailure = nodeResults.some((result) => (
    !result.ok && isTransientHistoricalFetchError(result.error)
  ));
  const hasTransientNetworkFailure = !networkData.ok && isTransientHistoricalFetchError(networkData.error);
  if (hasTransientNodeFailure || hasTransientNetworkFailure || !networkData.data) {
    return null;
  }

  return calculateBondHistoryRow({
    bondAddress,
    nodePayloads: nodeResults.map((result) => result?.data).filter(Boolean),
    networkData: networkData.data,
    churnHeight,
    churnTimestamp,
    ratesJson
  });
}

export async function handleBondHistory(_request, url) {
  const bondAddress = (url.searchParams.get('bond_address') || '').trim().toLowerCase();
  const includeHistorical = url.searchParams.get('include_historical') === 'true';
  const scope = getHistoryScope(includeHistorical);

  if (!isValidThorAddress(bondAddress)) {
    return error('Invalid bond_address parameter', 400);
  }

  const cachedResult = await query(
    `select churn_height, churn_timestamp, rune_stack, user_bond, rune_price, rates_json
     from bond_history
     where bond_address = $1
       and scope = $2
     order by churn_height asc`,
    [bondAddress, scope]
  );
  const legacyResult = await query(
    `select churn_height, churn_timestamp, rune_stack, user_bond, rune_price, rates_json
     from bond_history
     where bond_address = $1
       and scope = $2
     order by churn_height asc`,
    [bondAddress, BOND_HISTORY_SCOPE_LEGACY]
  );
  const historicalResult = scope === BOND_HISTORY_SCOPE_HISTORICAL
    ? { rows: cachedResult.rows || [] }
    : await query(
      `select churn_height, churn_timestamp, rune_stack, user_bond, rune_price, rates_json
       from bond_history
       where bond_address = $1
         and scope = $2
       order by churn_height asc`,
      [bondAddress, BOND_HISTORY_SCOPE_HISTORICAL]
    );
  const currentResult = scope === BOND_HISTORY_SCOPE_CURRENT
    ? { rows: cachedResult.rows || [] }
    : await query(
      `select churn_height, churn_timestamp, rune_stack, user_bond, rune_price, rates_json
       from bond_history
       where bond_address = $1
         and scope = $2
       order by churn_height asc`,
      [bondAddress, BOND_HISTORY_SCOPE_CURRENT]
    );

  const legacyCached = (legacyResult.rows || []).filter((row) => !isPoisonedBondHistoryRow(row));
  const historicalCached = (historicalResult.rows || []).filter((row) => !isPoisonedBondHistoryRow(row));
  const currentCached = (currentResult.rows || []).filter((row) => !isPoisonedBondHistoryRow(row));

  const {
    current: currentNodes,
    all: allNodes,
    discoveryComplete,
    discoveryError
  } = await getAllNodeAddresses(bondAddress);
  const discoveredHasHistorical = allNodes.length > currentNodes.length;
  const nodeAddresses = includeHistorical ? allNodes : currentNodes;

  if (includeHistorical && !discoveredHasHistorical && !discoveryComplete) {
    const fallbackRows = historicalCached.length > 0 ? historicalCached : legacyCached;
    if (fallbackRows.length === 0) {
      return error(`Historical bond discovery is temporarily unavailable: ${discoveryError}`, 503);
    }

    return cachedHistoryResponse({
      bondAddress,
      cachedRows: fallbackRows,
      hasHistorical: true,
      minHeight: 0,
      stale: true,
      warning: `Served cached historical bond rows after degraded node discovery: ${discoveryError}`
    });
  }

  const effectiveHasHistorical = inferHasHistoricalFromCache({
    discoveredHasHistorical,
    currentRows: currentCached,
    historicalRows: historicalCached,
    legacyRows: legacyCached
  });

  const cached = (cachedResult.rows || []).filter((row) => !isPoisonedBondHistoryRow(row));
  const cachedHeights = new Set(
    cached
      .filter((row) => row.user_bond != null)
      .map((row) => Number(row.churn_height))
  );

  if (nodeAddresses.length === 0) {
    return error('No active bonds found for this address', 404);
  }

  let allChurns = [];
  try {
    allChurns = await fetchChurns();
  } catch (churnError) {
    if (cached.length > 0 && isTransientHistoricalFetchError(churnError)) {
      console.warn(
        `[bond-history] serving cached history after transient churn fetch failure for ${bondAddress}: ${churnError.message}`
      );
      return cachedHistoryResponse({
        bondAddress,
        cachedRows: cached,
        hasHistorical: effectiveHasHistorical,
        minHeight: 0,
        stale: true,
        warning: 'Served cached bond history after transient upstream churn fetch failure'
      });
    }

    throw churnError;
  }
  const churns = allChurns.map((churn) => ({
    height: Number(churn.height),
    timestampSec: Math.floor(Number(churn.date) / 1e9)
  }));

  const uncached = churns.filter((churn) => !cachedHeights.has(churn.height));
  if (uncached.length === 0) {
    return cachedHistoryResponse({
      bondAddress,
      cachedRows: cached,
      hasHistorical: effectiveHasHistorical,
      minHeight: 0
    });
  }

  uncached.sort((left, right) => right.height - left.height);
  const zeroThreshold = includeHistorical ? 5 : 2;
  const newRows = [];
  let consecutiveZero = 0;
  const ratesJson = await fetchRatesJson();

  for (const churn of uncached) {
    const result = await processChurn(bondAddress, nodeAddresses, churn.height, churn.timestampSec, ratesJson);
    if (!result) {
      console.warn(
        `[bond-history] stopping historical backfill after transient fetch failure for ${bondAddress} at churn ${churn.height}`
      );
      break;
    }

    if (!hasBondHistoryValue(result)) {
      consecutiveZero += 1;
      if (consecutiveZero >= zeroThreshold) {
        break;
      }
      continue;
    } else {
      consecutiveZero = 0;
    }

    newRows.push({
      bond_address: bondAddress,
      scope,
      ...result
    });
  }

  if (newRows.length > 0) {
    const dbClient = await getClient();
    try {
      await upsertRows(dbClient, 'bond_history', newRows, {
        conflictColumns: ['bond_address', 'scope', 'churn_height'],
        jsonColumns: ['rates_json']
      });
    } finally {
      dbClient.release();
    }
  }

  const allData = [
    ...cached,
    ...newRows.map((row) => ({
      churn_height: row.churn_height,
      churn_timestamp: row.churn_timestamp,
      rune_stack: row.rune_stack,
      user_bond: row.user_bond,
      rune_price: row.rune_price,
      rates_json: row.rates_json
    }))
  ];

  const byHeight = new Map();
  for (const row of allData) {
    byHeight.set(Number(row.churn_height), row);
  }

  const history = Array.from(byHeight.values())
    .sort((left, right) => Number(left.churn_height) - Number(right.churn_height))
    .map((row) => normalizeHistoryRows([row])[0]);

  while (history.length > 0 && history[0].rune_stack === 0) {
    history.shift();
  }

  const responseHasHistorical = inferHasHistoricalFromCache({
    discoveredHasHistorical,
    currentRows: scope === BOND_HISTORY_SCOPE_CURRENT ? history : currentCached,
    historicalRows: scope === BOND_HISTORY_SCOPE_HISTORICAL ? history : historicalCached,
    legacyRows: legacyCached
  });

  return json(
    {
      bond_address: bondAddress,
      history,
      has_historical: responseHasHistorical,
      fetched: newRows.length,
      total: history.length
    },
    200,
    {
      'Cache-Control': 'public, max-age=30'
    }
  );
}
