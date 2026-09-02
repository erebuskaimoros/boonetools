import { getClient, query } from '../db/pool.js';
import { upsertRows } from '../db/sql.js';
import { error, isValidThorAddress, json } from '../lib/http.js';
import { config } from '../lib/config.js';
import { requestFromProviders } from '../lib/provider-client.js';
import {
  hasBondHistoryValue,
  isPoisonedBondHistoryRow,
  isTransientHistoricalFetchError
} from '../shared/bond-history.js';
import { enqueueBondHistoryRefresh } from '../shared/bond-history-refresh-queue.js';
import { executeDuneQueryRows, summarizeDuneError } from '../shared/dune.js';
import { fetchStockPrices } from '../shared/stock-prices.js';
import { fetchChurns, fetchNodes } from '../shared/thornode.js';
import { processChurn, scanBondActionWindow } from '../shared/bond-history-acquisition.js';

const BOND_HISTORY_SCOPE_CURRENT = 'current';
const BOND_HISTORY_SCOPE_HISTORICAL = 'historical';
const BOND_HISTORY_SCOPE_LEGACY = 'legacy';
const BOND_TX_EVENT_SYNC_TTL_MS = 6 * 60 * 60 * 1000;
const COINGECKO_BASE = 'https://api.coingecko.com';

function fetchCoinGecko(path) {
  return requestFromProviders({
    bases: [COINGECKO_BASE],
    path,
    timeoutMs: 10_000,
    headers: { Accept: 'application/json' }
  });
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

function normalizeDuneBondTxEvent(bondAddress, row) {
  const actionHeight = Number(row?.action_height);
  const txId = String(row?.tx_id || '');
  if (!txId || !Number.isFinite(actionHeight) || actionHeight <= 0) {
    return null;
  }

  const nodeAddress = String(row?.node_address || '');
  return {
    bond_address: bondAddress,
    tx_id: txId,
    action_height: Math.trunc(actionHeight),
    node_address: nodeAddress.startsWith('thor1') ? nodeAddress : '',
    action_type: String(row?.action_type || 'bond'),
    raw_action: {
      source: 'dune',
      dune_query_id: config.bondTxEventsDuneQueryId,
      row
    },
    updated_at: new Date().toISOString()
  };
}

async function loadBondTxEvents(bondAddress, client) {
  const { rows } = await (client ? client.query.bind(client) : query)(
    `select bond_address, tx_id, action_height, node_address, action_type, raw_action
     from bond_tx_events
     where bond_address = $1
     order by action_height asc`,
    [bondAddress]
  );

  return rows || [];
}

async function loadBondTxEventSyncState(bondAddress, client) {
  const { rows } = await (client ? client.query.bind(client) : query)(
    `select synced_at, complete, error, midgard_scanned_through, midgard_source_key, midgard_scan_json, dune_seeded_at
     from bond_tx_event_sync_state
     where bond_address = $1
     limit 1`,
    [bondAddress]
  );

  return rows[0] || null;
}

function isFreshBondTxSync(syncState) {
  const syncedAtMs = Date.parse(String(syncState?.synced_at || ''));
  const age = Date.now() - syncedAtMs;
  const ttl = syncState?.complete ? BOND_TX_EVENT_SYNC_TTL_MS : 30_000;
  return Number.isFinite(syncedAtMs) && age >= 0 && age < ttl;
}

async function saveBondTxEventSyncState(client, bondAddress, payload) {
  await client.query(
    `insert into bond_tx_event_sync_state as current (
       bond_address, synced_at, complete, error, midgard_scanned_through,
       midgard_source_key, midgard_scan_json, dune_seeded_at
     ) values ($1, now(), $2, $3, $4, $5, $6::jsonb, $7)
     on conflict (bond_address) do update set
       synced_at = excluded.synced_at, complete = excluded.complete, error = excluded.error,
       midgard_scanned_through = coalesce(excluded.midgard_scanned_through, current.midgard_scanned_through),
       midgard_source_key = coalesce(excluded.midgard_source_key, current.midgard_source_key),
       midgard_scan_json = excluded.midgard_scan_json,
       dune_seeded_at = coalesce(excluded.dune_seeded_at, current.dune_seeded_at)`,
    [bondAddress, Boolean(payload.complete), payload.error || '',
      payload.coveredThrough ? new Date(payload.coveredThrough * 1000).toISOString() : null,
      payload.coveredThrough ? payload.sourceKey : null, JSON.stringify(payload.progress || {}),
      payload.duneSeededAt || null]
  );
}

async function scanAndCacheBondTxEvents(bondAddress) {
  const client = await getClient();
  const lockKey = `bond-actions:${bondAddress}`;
  try {
    await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    const previous = await loadBondTxEventSyncState(bondAddress, client);
    // Both scope queues can reach this lane together; recheck after the lock.
    if (isFreshBondTxSync(previous)) return {
      events: await loadBondTxEvents(bondAddress, client), complete: Boolean(previous.complete), error: previous.error || ''
    };
    const rows = [];
    let duneSeededAt = null;
    let duneError = '';
    // Dune seeds old events once. Only Midgard's own verified window can establish
    // its durable incremental boundary; a last matching event is not coverage.
    if (!previous && config.duneApiKey && config.bondTxEventsDuneQueryId) {
      try {
        const result = await executeDuneQueryRows(config.bondTxEventsDuneQueryId, {
          bond_address: bondAddress, start_time: config.bondTxEventsDuneStartTime, limit: config.bondTxEventsDuneLimit
        }, { limit: config.bondTxEventsDuneLimit });
        rows.push(...result.rows.map((row) => normalizeDuneBondTxEvent(bondAddress, row)).filter(Boolean));
        duneSeededAt = new Date().toISOString();
      } catch (error) { duneError = summarizeDuneError(error).message; }
    }
    let scan;
    try {
      scan = await scanBondActionWindow(bondAddress, {
        client, coveredThrough: Date.parse(previous?.midgard_scanned_through || '') / 1000,
        coveredSourceKey: previous?.midgard_source_key, progress: previous?.midgard_scan_json,
        validateAction: (action) => Boolean(normalizeBondTxEvent(bondAddress, action))
      });
    } catch (error) {
      scan = { actions: [], complete: false, coveredThrough: null,
        progress: previous?.midgard_scan_json, error: error?.message || String(error) };
    }
    rows.push(...scan.actions.map((action) => normalizeBondTxEvent(bondAddress, action)).filter(Boolean));
    const rowsByKey = new Map(rows.map((row) => [`${row.tx_id}:${row.action_height}`, row]));
    const error = scan.error || (duneError ? `Dune seed failed; served Midgard (${duneError})` : '');
    await client.query('begin');
    try {
      await upsertRows(client, 'bond_tx_events', [...rowsByKey.values()], {
        conflictColumns: ['bond_address', 'tx_id', 'action_height'], jsonColumns: ['raw_action']
      });
      await saveBondTxEventSyncState(client, bondAddress, { ...scan, error, duneSeededAt });
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    return { events: await loadBondTxEvents(bondAddress, client), complete: scan.complete, error };
  } finally {
    try { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]); }
    finally { client.release(); }
  }
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
      fetchCoinGecko('/api/v3/simple/price?ids=thorchain&vs_currencies=eur,gbp,jpy,btc,xau'),
      fetchCoinGecko('/api/v3/simple/price?ids=monero,zcash&vs_currencies=usd'),
      fetchStockPrices(['SPY', 'VT', 'GC=F'])
    ]);

    const rates = {};

    if (fiatResponse.status === 'fulfilled') {
      const data = fiatResponse.value;
      const thorchain = data?.thorchain;
      if (thorchain?.eur) rates.EUR = thorchain.eur;
      if (thorchain?.gbp) rates.GBP = thorchain.gbp;
      if (thorchain?.jpy) rates.JPY = thorchain.jpy;
      if (thorchain?.btc) rates.BTC = thorchain.btc;
      if (thorchain?.xau) rates.XAU = thorchain.xau;
    }

    if (cryptoResponse.status === 'fulfilled') {
      const data = cryptoResponse.value;
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
  warning = '',
  refreshStatus = '',
  headers = {}
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
  if (refreshStatus) {
    payload.refresh_status = refreshStatus;
  }

  return json(payload, 200, {
    'Cache-Control': stale ? 'public, max-age=15' : 'public, max-age=30',
    ...headers
  });
}

export async function handleBondHistory(request, url) {
  const bondAddress = (url.searchParams.get('bond_address') || '').trim().toLowerCase();
  const includeHistorical = url.searchParams.get('include_historical') === 'true';
  const includeBondTxs = url.searchParams.get('include_bond_txs') === 'true';
  const scope = getHistoryScope(includeHistorical);
  const refreshMode = String(url.searchParams.get('refresh') || '').toLowerCase();
  const preferHeader = String(request?.headers?.prefer || request?.headers?.get?.('prefer') || '').toLowerCase();
  const prefersAsync = preferHeader.split(',').some((value) => value.trim() === 'respond-async');

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
  const cached = (cachedResult.rows || []).filter((row) => !isPoisonedBondHistoryRow(row));

  if (refreshMode === 'status') {
    if (cached.length > 0) {
      const cachedBondTxEvents = includeBondTxs ? await loadBondTxEvents(bondAddress) : [];
      return cachedHistoryResponse({
        bondAddress,
        cachedRows: cached,
        hasHistorical: inferHasHistoricalFromCache({
          discoveredHasHistorical: false,
          currentRows: currentCached,
          historicalRows: historicalCached,
          legacyRows: legacyCached
        }),
        minHeight: 0,
        bondTxEvents: cachedBondTxEvents,
        includeBondTxs
      });
    }

    return json({
      bond_address: bondAddress,
      history: [],
      has_historical: includeHistorical,
      fetched: 0,
      total: 0,
      refresh_status: 'queued'
    }, 202, { 'Cache-Control': 'no-store', 'Retry-After': '5' });
  }

  // Normal reads are cache-only and enqueue refresh work. The queue is keyed by
  // address+scope, so hot dashboard traffic coalesces and never performs Dune,
  // archive-node, or churn scans in the request path. Explicit refresh=sync is
  // reserved for the worker and operational repair tooling.
  if (refreshMode !== 'sync') {
    try {
      await enqueueBondHistoryRefresh({
        bondAddress,
        scope,
        includeBondTxs
      });

      if (cached.length > 0) {
        const cachedBondTxEvents = includeBondTxs ? await loadBondTxEvents(bondAddress) : [];
        const hasHistorical = inferHasHistoricalFromCache({
          discoveredHasHistorical: false,
          currentRows: currentCached,
          historicalRows: historicalCached,
          legacyRows: legacyCached
        });
        return cachedHistoryResponse({
          bondAddress,
          cachedRows: cached,
          hasHistorical,
          minHeight: 0,
          bondTxEvents: cachedBondTxEvents,
          includeBondTxs,
          refreshStatus: 'queued',
          headers: prefersAsync ? { 'Preference-Applied': 'respond-async' } : {}
        });
      }

      return json({
        bond_address: bondAddress,
        history: [],
        has_historical: includeHistorical,
        fetched: 0,
        total: 0,
        refresh_status: 'queued'
      }, 202, {
        'Cache-Control': 'no-store',
        ...(prefersAsync ? { 'Preference-Applied': 'respond-async' } : {}),
        'Retry-After': '5'
      });
    } catch (queueError) {
      console.warn(`[bond-history] unable to queue refresh for ${bondAddress}: ${queueError.message}`);
      if (cached.length > 0) {
        const cachedBondTxEvents = includeBondTxs ? await loadBondTxEvents(bondAddress) : [];
        return cachedHistoryResponse({
          bondAddress,
          cachedRows: cached,
          hasHistorical: inferHasHistoricalFromCache({
            discoveredHasHistorical: false,
            currentRows: currentCached,
            historicalRows: historicalCached,
            legacyRows: legacyCached
          }),
          minHeight: 0,
          bondTxEvents: cachedBondTxEvents,
          includeBondTxs,
          stale: true,
          warning: 'Served cached history because the refresh queue is unavailable'
        });
      }
      return error('Unable to queue bond history refresh', 503, { 'Retry-After': '10' });
    }
  }

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
      includeBondTxs,
      stale: !discoveryComplete,
      warning: discoveryComplete ? '' : `Bond action discovery remains incomplete: ${discoveryError}`
    });
  }

  uncached.sort((left, right) => right.height - left.height);
  const zeroThreshold = includeHistorical ? 5 : 2;
  const newRows = [];
  let refreshPartial = !discoveryComplete;
  let consecutiveZero = 0;
  const ratesJson = await fetchRatesJson();

  for (const churn of uncached) {
    const result = await processChurn(bondAddress, nodeAddresses, churn.height, churn.timestampSec, ratesJson);
    if (!result) {
      console.warn(
        `[bond-history] stopping historical backfill after transient fetch failure for ${bondAddress} at churn ${churn.height}`
      );
      refreshPartial = true;
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

  if (refreshPartial) {
    payload.stale = true;
    payload.partial = true;
    payload.warning = discoveryComplete ? 'Historical refresh stopped after an upstream failure'
      : `Bond action discovery remains incomplete: ${discoveryError}`;
  }

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
