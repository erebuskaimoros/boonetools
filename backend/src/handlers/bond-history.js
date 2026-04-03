import { getClient, query } from '../db/pool.js';
import { upsertRows } from '../db/sql.js';
import { error, isValidThorAddress, json } from '../lib/http.js';
import {
  calculateBondHistoryRow,
  hasBondHistoryValue,
  isPoisonedBondHistoryRow,
  isTransientHistoricalFetchError
} from '../shared/bond-history.js';
import { fetchMidgardActions, fetchMidgardBond } from '../shared/midgard.js';
import { fetchStockPrices } from '../shared/stock-prices.js';
import { fetchChurns, fetchThorchain } from '../shared/thornode.js';

async function fetchNodeAtHeight(nodeAddress, height) {
  return fetchThorchain(`/thorchain/node/${nodeAddress}?height=${height}`, { historical: true });
}

async function fetchNetworkAtHeight(height) {
  return fetchThorchain(`/thorchain/network?height=${height}`, { historical: true });
}

async function getCurrentNodeAddresses(bondAddress) {
  const data = await fetchMidgardBond(bondAddress);
  return (data.nodes || [])
    .filter((node) => Number(node.bond) > 1e8)
    .map((node) => node.address);
}

async function getAllNodeAddresses(bondAddress) {
  const currentNodes = await getCurrentNodeAddresses(bondAddress);
  const currentSet = new Set(currentNodes);
  const nodeSet = new Set(currentNodes);
  let earliestCurrentBondHeight = Infinity;

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
  } catch {
    // Current nodes are enough for a degraded response.
  }

  return {
    current: currentNodes,
    all: Array.from(nodeSet),
    currentNodesSinceHeight: earliestCurrentBondHeight === Infinity ? 0 : earliestCurrentBondHeight
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

  if (!isValidThorAddress(bondAddress)) {
    return error('Invalid bond_address parameter', 400);
  }

  const cachedResult = await query(
    `select churn_height, churn_timestamp, rune_stack, user_bond, rune_price, rates_json
     from bond_history
     where bond_address = $1
     order by churn_height asc`,
    [bondAddress]
  );

  const cached = (cachedResult.rows || []).filter((row) => !isPoisonedBondHistoryRow(row));
  const cachedHeights = new Set(
    cached
      .filter((row) => row.user_bond != null)
      .map((row) => Number(row.churn_height))
  );

  const { current: currentNodes, all: allNodes, currentNodesSinceHeight } = await getAllNodeAddresses(bondAddress);
  const hasHistorical = allNodes.length > currentNodes.length;
  const nodeAddresses = includeHistorical ? allNodes : currentNodes;

  if (nodeAddresses.length === 0) {
    return error('No active bonds found for this address', 404);
  }

  const allChurns = await fetchChurns();
  const churns = allChurns.map((churn) => ({
    height: Number(churn.height),
    timestampSec: Math.floor(Number(churn.date) / 1e9)
  }));

  const uncached = churns.filter((churn) => !cachedHeights.has(churn.height));
  if (uncached.length === 0) {
    const minHeight = includeHistorical ? 0 : currentNodesSinceHeight;
    const filtered = cached.filter((row) => Number(row.rune_stack) > 0 && Number(row.churn_height) >= minHeight);

    return json(
      {
        bond_address: bondAddress,
        history: filtered.map((row) => ({
          churn_height: Number(row.churn_height),
          churn_timestamp: Number(row.churn_timestamp),
          rune_stack: Number(row.rune_stack),
          user_bond: row.user_bond == null ? null : Number(row.user_bond),
          rune_price: Number(row.rune_price),
          rates_json: row.rates_json || null
        })),
        has_historical: hasHistorical,
        fetched: 0,
        total: filtered.length
      },
      200,
      {
        'Cache-Control': 'public, max-age=30'
      }
    );
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

    newRows.push({
      bond_address: bondAddress,
      ...result
    });

    if (!hasBondHistoryValue(result)) {
      consecutiveZero += 1;
      if (consecutiveZero >= zeroThreshold) {
        break;
      }
    } else {
      consecutiveZero = 0;
    }
  }

  if (newRows.length > 0) {
    const dbClient = await getClient();
    try {
      await upsertRows(dbClient, 'bond_history', newRows, {
        conflictColumns: ['bond_address', 'churn_height'],
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

  const minHeight = includeHistorical ? 0 : currentNodesSinceHeight;
  const byHeight = new Map();
  for (const row of allData) {
    if (Number(row.churn_height) >= minHeight) {
      byHeight.set(Number(row.churn_height), row);
    }
  }

  const history = Array.from(byHeight.values())
    .sort((left, right) => Number(left.churn_height) - Number(right.churn_height))
    .map((row) => ({
      churn_height: Number(row.churn_height),
      churn_timestamp: Number(row.churn_timestamp),
      rune_stack: Number(row.rune_stack),
      user_bond: row.user_bond == null ? null : Number(row.user_bond),
      rune_price: Number(row.rune_price),
      rates_json: row.rates_json || null
    }));

  while (history.length > 0 && history[0].rune_stack === 0) {
    history.shift();
  }

  return json(
    {
      bond_address: bondAddress,
      history,
      has_historical: hasHistorical,
      fetched: newRows.length,
      total: history.length
    },
    200,
    {
      'Cache-Control': 'public, max-age=30'
    }
  );
}
