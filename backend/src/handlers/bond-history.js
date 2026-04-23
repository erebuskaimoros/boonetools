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
const BOND_TX_EVENT_SYNC_TTL_MS = 6 * 60 * 60 * 1000;
const BOND_TX_EVENT_PAGE_SIZE = 50;
const BOND_TX_EVENT_MAX_PAGES = 20;

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

function normalizeBondTxEvent(bondAddress, action) {
  const actionHeight = Number(action?.height);
  const txId = String(action?.in?.[0]?.txID || action?.out?.[0]?.txID || '');
  const nodeAddress = String(action?.metadata?.bond?.nodeAddress || '');
  if (!txId || !Number.isFinite(actionHeight) || actionHeight <= 0) {
    return null;
  }

  return {
    bond_address: bondAddress,
    tx_id: txId,
    action_height: Math.trunc(actionHeight),
    node_address: nodeAddress.startsWith('thor1') ? nodeAddress : '',
    action_type: String(action?.type || 'bond'),
    raw_action: action || {},
    updated_at: new Date().toISOString()
  };
}

async function loadBondTxEvents(bondAddress) {
  const { rows } = await query(
    `select bond_address, tx_id, action_height, node_address, action_type, raw_action
     from bond_tx_events
     where bond_address = $1
     order by action_height asc`,
    [bondAddress]
  );

  return rows || [];
}

async function loadBondTxEventSyncState(bondAddress) {
  const { rows } = await query(
    `select synced_at, complete, error
     from bond_tx_event_sync_state
     where bond_address = $1
     limit 1`,
    [bondAddress]
  );

  return rows[0] || null;
}

function isFreshBondTxSync(syncState) {
  const syncedAtMs = Date.parse(String(syncState?.synced_at || ''));
  return Number.isFinite(syncedAtMs) && Date.now() - syncedAtMs < BOND_TX_EVENT_SYNC_TTL_MS;
}

async function saveBondTxEventSyncState(client, bondAddress, payload) {
  await client.query(
    `insert into bond_tx_event_sync_state (bond_address, synced_at, complete, error)
     values ($1, now(), $2, $3)
     on conflict (bond_address)
     do update set
       synced_at = excluded.synced_at,
       complete = excluded.complete,
       error = excluded.error`,
    [
      bondAddress,
      Boolean(payload.complete),
      payload.error || ''
    ]
  );
}

async function scanAndCacheBondTxEvents(bondAddress) {
  const rowsByKey = new Map();
  let offset = 0;
  let complete = false;
  let errorMessage = '';

  for (let page = 0; page < BOND_TX_EVENT_MAX_PAGES; page += 1) {
    const data = await fetchMidgardActions({
      address: bondAddress,
      type: 'bond',
      limit: BOND_TX_EVENT_PAGE_SIZE,
      offset
    });
    const actions = data.actions || [];

    for (const action of actions) {
      const row = normalizeBondTxEvent(bondAddress, action);
      if (!row) {
        continue;
      }
      rowsByKey.set(`${row.tx_id}:${row.action_height}`, row);
    }

    if (actions.length < BOND_TX_EVENT_PAGE_SIZE) {
      complete = true;
      break;
    }

    offset += actions.length;
  }

  if (!complete) {
    errorMessage = `Bond action scan reached ${BOND_TX_EVENT_MAX_PAGES} pages`;
  }

  const rows = [...rowsByKey.values()];
  const dbClient = await getClient();
  try {
    await upsertRows(dbClient, 'bond_tx_events', rows, {
      conflictColumns: ['bond_address', 'tx_id', 'action_height'],
      jsonColumns: ['raw_action']
    });
    await saveBondTxEventSyncState(dbClient, bondAddress, {
      complete,
      error: errorMessage
    });
  } finally {
    dbClient.release();
  }

  return {
    events: await loadBondTxEvents(bondAddress),
    complete,
    error: errorMessage
  };
}

async function getBondTxEvents(bondAddress) {
  const [cachedEvents, syncState] = await Promise.all([
    loadBondTxEvents(bondAddress),
    loadBondTxEventSyncState(bondAddress)
  ]);

  if (isFreshBondTxSync(syncState)) {
    return {
      events: cachedEvents,
      complete: Boolean(syncState.complete),
      error: syncState.error || ''
    };
  }

  try {
    return await scanAndCacheBondTxEvents(bondAddress);
  } catch (scanError) {
    if (cachedEvents.length > 0) {
      return {
        events: cachedEvents,
        complete: false,
        error: scanError.message || 'Unable to refresh bond action cache'
      };
    }
    throw scanError;
  }
}

function buildBondTxMap(events, historyRows) {
  const heights = (historyRows || [])
    .map((row) => Number(row.churn_height))
    .filter((height) => Number.isFinite(height) && height > 0)
    .sort((left, right) => left - right);
  const map = {};

  for (const event of events || []) {
    const actionHeight = Number(event.action_height);
    const txId = String(event.tx_id || '');
    if (!txId || !Number.isFinite(actionHeight) || actionHeight <= 0) {
      continue;
    }

    for (let i = 1; i < heights.length; i += 1) {
      const previousHeight = heights[i - 1];
      const churnHeight = heights[i];
      if (actionHeight > previousHeight && actionHeight <= churnHeight) {
        const key = String(churnHeight);
        if (!map[key]) {
          map[key] = [];
        }
        if (!map[key].includes(txId)) {
          map[key].push(txId);
        }
        break;
      }
    }
  }

  return map;
}

async function getAllNodeAddresses(bondAddress) {
  const currentNodes = await getCurrentNodeAddresses(bondAddress);
  const currentSet = new Set(currentNodes);
  const nodeSet = new Set(currentNodes);
  let earliestCurrentBondHeight = Infinity;
  let discoveryComplete = true;
  let discoveryError = '';
  let bondTxEvents = [];

  try {
    const eventResult = await getBondTxEvents(bondAddress);
    bondTxEvents = eventResult.events || [];
    discoveryComplete = Boolean(eventResult.complete);
    discoveryError = eventResult.error || '';

    for (const event of bondTxEvents) {
      const nodeAddress = event.node_address;
      if (!nodeAddress || !nodeAddress.startsWith('thor1')) {
        continue;
      }

      nodeSet.add(nodeAddress);
      if (currentSet.has(nodeAddress)) {
        const height = Number(event.action_height);
        if (height > 0 && height < earliestCurrentBondHeight) {
          earliestCurrentBondHeight = height;
        }
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
    bondTxEvents,
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
  bondTxEvents = [],
  includeBondTxs = false,
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

  if (includeBondTxs) {
    payload.bond_tx_map = buildBondTxMap(bondTxEvents, filtered);
  }

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
  const includeBondTxs = url.searchParams.get('include_bond_txs') === 'true';
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
    bondTxEvents,
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
      bondTxEvents,
      includeBondTxs,
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
        bondTxEvents,
        includeBondTxs,
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
      minHeight: 0,
      bondTxEvents,
      includeBondTxs
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

  const payload = {
    bond_address: bondAddress,
    history,
    has_historical: responseHasHistorical,
    fetched: newRows.length,
    total: history.length
  };

  if (includeBondTxs) {
    payload.bond_tx_map = buildBondTxMap(bondTxEvents, history);
  }

  return json(
    payload,
    200,
    {
      'Cache-Control': 'public, max-age=30'
    }
  );
}
