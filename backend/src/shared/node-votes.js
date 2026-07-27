import { query } from '../db/pool.js';
import { upsertRows } from '../db/sql.js';
import { config } from '../lib/config.js';
import {
  canonicalNodeVoteKey,
  choosePreferredSource,
  EVENT_SOURCE_PRIORITY,
  enrichEventRows,
  recordEventSourceObservations,
  selectPreferredEventRows,
  withEventTransaction
} from '../lib/provenance.js';
import { sleep } from '../lib/utils.js';
import { executeDuneQueryRows, formatDuneDateTime } from './dune.js';
import { fetchThorchainRpc } from './rpc.js';
import { fetchThorchain } from './thornode.js';

const THORNODE_TIMEOUT_MS = 8000;
const TX_SEARCH_MAX_PAGE_SIZE = 100;
const SYNC_KEY = 'node-votes-backfill';

const NODE_VOTE_COLUMNS = [
  'event_key',
  'tx_id',
  'height',
  'block_time',
  'event_index',
  'node_address',
  'node_operator_address',
  'node_status',
  'mimir_key',
  'vote_value',
  'vote_value_numeric',
  'source',
  'raw_event',
  'observed_at',
  'updated_at',
  'canonical_key',
  'preferred_source',
  'first_seen_at',
  'last_seen_at',
  'schema_version'
];

function nodeVoteSource(row) {
  return choosePreferredSource('', row?.source || 'unknown');
}

async function upsertCanonicalNodeVotes(client, rows) {
  if (rows.length === 0) return;
  await upsertRows(client, 'node_votes', rows, {
    columns: NODE_VOTE_COLUMNS,
    conflictColumns: ['canonical_key'],
    updateColumns: NODE_VOTE_COLUMNS.filter(
      (column) => column !== 'canonical_key'
    ),
    updateStrategies: {
      first_seen_at: 'least',
      last_seen_at: 'greatest',
      schema_version: 'greatest'
    },
    sourcePreference: {
      column: 'preferred_source',
      priorities: EVENT_SOURCE_PRIORITY,
      observedAtColumn: 'last_seen_at'
    },
    jsonColumns: ['raw_event'],
    chunkSize: 250
  });
}

function normalizePath(path) {
  return path.startsWith('/') ? path : `/${path}`;
}

export async function fetchNodeVotesRpc(path, params = {}, options = {}) {
  return fetchThorchainRpc(path, params, {
    ...options,
    rpcUrls: options.rpcUrls || config.nodeVotesRpcUrls
  });
}

async function fetchThornodeApi(path, options = {}) {
  const url = new URL(normalizePath(path), 'http://thornode.local');
  for (const [key, value] of Object.entries(options.params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  return fetchThorchain(`${url.pathname}${url.search}`, {
    historical: Boolean(options.historical),
    timeoutMs: options.timeoutMs || THORNODE_TIMEOUT_MS
  });
}

export function tryDecode(value) {
  if (!value) {
    return '';
  }

  try {
    if (/^[A-Za-z0-9+/]+=*$/.test(value) && value.length > 1) {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      if (/^[\x20-\x7E]*$/.test(decoded) && decoded.length > 0) {
        return decoded;
      }
    }
  } catch {
    // Keep the raw value.
  }

  return String(value);
}

function eventAttributes(event) {
  const attrs = {};
  for (const attribute of event?.attributes || []) {
    const key = tryDecode(attribute.key);
    if (!key) {
      continue;
    }
    attrs[key] = tryDecode(attribute.value);
  }
  return attrs;
}

function numericVoteValue(value) {
  const normalized = String(value ?? '').trim();
  return /^-?\d+(\.\d+)?$/.test(normalized) ? normalized : null;
}

function toIsoOrNull(value) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseJsonObject(value, fallback = {}) {
  if (value && typeof value === 'object') {
    return value;
  }
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function buildEventKey({ txId, height, txIndex, eventIndex, attrs }) {
  if (txId) {
    return `${txId}:${eventIndex}`;
  }

  return [
    height || 0,
    txIndex ?? 'block',
    eventIndex,
    attrs.address || '',
    attrs.key || '',
    attrs.value || ''
  ].join(':');
}

export function parseNodeVoteEvents(events, envelope = {}) {
  const rows = [];
  const height = Number(envelope.height || envelope.blockHeight || 0) || 0;
  const txId = String(envelope.txId || envelope.tx_id || '').toUpperCase();
  const txIndex = Number.isFinite(Number(envelope.txIndex)) ? Number(envelope.txIndex) : null;
  const blockTime = toIsoOrNull(envelope.blockTime) || null;

  (events || []).forEach((event, index) => {
    if (event?.type !== 'set_node_mimir') {
      return;
    }

    const attrs = eventAttributes(event);
    const mimirKey = String(attrs.key || '').trim().toUpperCase();
    const nodeAddress = String(attrs.address || attrs.signer || '').trim();
    const voteValue = String(attrs.value ?? '').trim();

    if (!mimirKey || !nodeAddress) {
      return;
    }

    rows.push({
      event_key: buildEventKey({
        txId,
        height,
        txIndex,
        eventIndex: index,
        attrs
      }),
      tx_id: txId,
      height,
      block_time: blockTime,
      event_index: index,
      node_address: nodeAddress,
      node_operator_address: '',
      node_status: '',
      mimir_key: mimirKey,
      vote_value: voteValue,
      vote_value_numeric: numericVoteValue(voteValue),
      source: envelope.source || 'backfill',
      raw_event: {
        type: event.type,
        attributes: attrs,
        tx_index: txIndex
      },
      observed_at: envelope.observedAt || new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  });

  return rows;
}

export function parseNodeVoteTxSearchTx(tx, blockTime = null) {
  return parseNodeVoteEvents(tx?.tx_result?.events || [], {
    txId: tx?.hash || '',
    height: Number(tx?.height || 0),
    txIndex: Number(tx?.index || 0),
    blockTime,
    source: 'backfill'
  });
}

export function parseNodeVoteCosmosTxResponse(txResponse) {
  return parseNodeVoteEvents(txResponse?.events || [], {
    txId: txResponse?.txhash || '',
    height: Number(txResponse?.height || 0),
    txIndex: Number(txResponse?.tx_index || 0),
    blockTime: txResponse?.timestamp || null,
    source: 'rpc'
  });
}

export function buildNodeVoteRowsFromDune(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const mimirKey = String(row?.mimir_key || '').trim().toUpperCase();
      const nodeAddress = String(row?.node_address || '').trim();
      const eventKey = String(row?.event_key || '').trim();
      const blockTime = toIsoOrNull(row?.block_time);

      if (!eventKey || !mimirKey || !nodeAddress || !blockTime) {
        return null;
      }

      return {
        event_key: eventKey,
        tx_id: String(row?.tx_id || '').toUpperCase(),
        height: Number(row?.height || 0) || 0,
        block_time: blockTime,
        event_index: String(row?.event_index || '0'),
        node_address: nodeAddress,
        node_operator_address: String(row?.node_operator_address || ''),
        node_status: String(row?.node_status || ''),
        mimir_key: mimirKey,
        vote_value: String(row?.vote_value ?? '').trim(),
        vote_value_numeric: numericVoteValue(row?.vote_value),
        source: 'dune',
        raw_event: {
          ...parseJsonObject(row?.raw_event),
          dune_query_id: config.nodeVotesDuneQueryId
        },
        observed_at: toIsoOrNull(row?.observed_at) || new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    })
    .filter(Boolean);
}

async function fetchNodeVoteDuneRows(startTime, endTime) {
  const result = await executeDuneQueryRows(config.nodeVotesDuneQueryId, {
    start_time: formatDuneDateTime(startTime),
    end_time: formatDuneDateTime(endTime)
  });

  return {
    executionId: result.executionId,
    rows: buildNodeVoteRowsFromDune(result.rows)
  };
}

export async function upsertNodeVotes(client, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }

  const enriched = await enrichEventRows(client, {
    table: 'node_votes',
    rows,
    canonicalKey: canonicalNodeVoteKey,
    source: nodeVoteSource,
    observedAt: (row) => row.observed_at
  });
  const canonicalRows = selectPreferredEventRows(enriched);

  await withEventTransaction(client, async () => {
    await upsertCanonicalNodeVotes(client, canonicalRows);
    await recordEventSourceObservations(client, {
      domain: 'node-votes',
      rows: enriched,
      source: nodeVoteSource,
      sourceEventKey: (row) => row.event_key,
      rawReference: (row) => ({
        event_key: row.event_key,
        tx_id: row.tx_id,
        height: row.height
      })
    });
  });

  return enriched.length;
}

function normalizeNodeMetadata(node) {
  if (!node?.node_address) {
    return null;
  }

  return {
    node_address: String(node.node_address || ''),
    node_operator_address: String(node.node_operator_address || ''),
    node_status: String(node.status || '')
  };
}

async function fetchCurrentNodeMap() {
  const nodes = await fetchThornodeApi('/thorchain/nodes');
  const map = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const metadata = normalizeNodeMetadata(node);
    if (metadata) {
      map.set(metadata.node_address, metadata);
    }
  }
  return map;
}

async function fetchHistoricalNodeMetadata(nodeAddress, height) {
  const node = await fetchThornodeApi(`/thorchain/node/${nodeAddress}`, {
    historical: true,
    params: height > 0 ? { height } : {}
  });
  return normalizeNodeMetadata(node);
}

async function runConcurrent(items, concurrency, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

export async function enrichRowsWithNodeMetadata(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const nodeMap = await fetchCurrentNodeMap().catch(() => new Map());
  const missingByNode = new Map();

  for (const row of rows) {
    if (!nodeMap.has(row.node_address) && !missingByNode.has(row.node_address)) {
      missingByNode.set(row.node_address, row);
    }
  }

  await runConcurrent(
    [...missingByNode.values()],
    Math.max(1, config.nodeVotesNodeMetadataConcurrency),
    async (row) => {
      try {
        const metadata = await fetchHistoricalNodeMetadata(row.node_address, row.height);
        if (metadata) {
          nodeMap.set(row.node_address, metadata);
        }
      } catch {
        // Metadata is nice-to-have; keep the vote even if a historical node lookup fails.
      }
      if (config.nodeVotesRequestDelayMs > 0) {
        await sleep(config.nodeVotesRequestDelayMs);
      }
    }
  );

  return rows.map((row) => {
    const metadata = nodeMap.get(row.node_address);
    return {
      ...row,
      node_operator_address: metadata?.node_operator_address || row.node_operator_address || '',
      node_status: metadata?.node_status || row.node_status || ''
    };
  });
}

function sixMonthsAgo(reference) {
  const start = new Date(reference.getTime());
  start.setUTCMonth(start.getUTCMonth() - Math.max(1, config.nodeVotesBackfillMonths));
  return start;
}

function daysAgo(reference, days) {
  const start = new Date(reference.getTime());
  start.setUTCDate(start.getUTCDate() - Math.max(1, Math.trunc(Number(days) || 1)));
  return start;
}

export function resolveNodeVoteBackfillWindow({ endTime, startTime, latestStoredTime } = {}) {
  const resolvedEndTime = toIsoOrNull(endTime) || new Date().toISOString();
  const explicitStartTime = toIsoOrNull(startTime);
  if (explicitStartTime) {
    return {
      mode: 'explicit',
      startTime: explicitStartTime,
      endTime: resolvedEndTime,
      latestStoredTime: toIsoOrNull(latestStoredTime) || '',
      lookbackDays: 0
    };
  }

  const fullStartTime = sixMonthsAgo(new Date(resolvedEndTime)).toISOString();
  const storedTime = toIsoOrNull(latestStoredTime);
  if (!storedTime) {
    return {
      mode: 'full',
      startTime: fullStartTime,
      endTime: resolvedEndTime,
      latestStoredTime: '',
      lookbackDays: 0
    };
  }

  const lookbackDays = Math.max(1, Math.trunc(Number(config.nodeVotesBackfillLookbackDays) || 14));
  const rollingStartTime = daysAgo(new Date(storedTime), lookbackDays).toISOString();
  return {
    mode: 'rolling',
    startTime: new Date(Math.max(Date.parse(fullStartTime), Date.parse(rollingStartTime))).toISOString(),
    endTime: resolvedEndTime,
    latestStoredTime: storedTime,
    lookbackDays
  };
}

function statusHeights(status) {
  const syncInfo = status?.result?.sync_info || {};
  return {
    earliestHeight: Number(syncInfo.earliest_block_height || 0),
    latestHeight: Number(syncInfo.latest_block_height || 0),
    earliestTime: toIsoOrNull(syncInfo.earliest_block_time),
    latestTime: toIsoOrNull(syncInfo.latest_block_time)
  };
}

export async function fetchNodeVotesRpcStatus() {
  return fetchNodeVotesRpc('/status');
}

export async function fetchNodeVotesBlockTime(height) {
  const payload = await fetchNodeVotesRpc('/block', {
    height: Math.trunc(Number(height))
  });

  return toIsoOrNull(payload?.result?.block?.header?.time);
}

export async function findNodeVotesStartHeight(startTime, status = null) {
  const rpcStatus = status || await fetchNodeVotesRpcStatus();
  const bounds = statusHeights(rpcStatus);
  const targetMs = Date.parse(startTime);

  if (!Number.isFinite(targetMs)) {
    throw new Error(`Invalid node vote start time: ${startTime}`);
  }

  if (bounds.earliestHeight <= 0 || bounds.latestHeight <= 0) {
    throw new Error('Unable to read RPC block height bounds');
  }

  if (bounds.earliestTime && Date.parse(bounds.earliestTime) >= targetMs) {
    return bounds.earliestHeight;
  }

  if (bounds.latestTime && Date.parse(bounds.latestTime) <= targetMs) {
    return bounds.latestHeight;
  }

  let low = bounds.earliestHeight;
  let high = bounds.latestHeight;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    let midTime = null;
    let initialError = null;
    try {
      midTime = await fetchNodeVotesBlockTime(mid);
    } catch (error) {
      initialError = error;
      // Liquify archive routing can occasionally reject one otherwise valid
      // block with "Too many hops". An adjacent block is close enough for the
      // time-to-height binary search and avoids failing the entire backfill.
      for (const nearbyHeight of [mid - 1, mid + 1]) {
        if (nearbyHeight < low || nearbyHeight > high) continue;
        try {
          midTime = await fetchNodeVotesBlockTime(nearbyHeight);
          break;
        } catch {
          // Try the other adjacent height before preserving the first error.
        }
      }
    }
    if (!midTime && initialError) throw initialError;
    const midMs = Date.parse(midTime || '');

    if (!Number.isFinite(midMs)) {
      throw new Error(`Unable to read block time for height ${mid}`);
    }

    if (midMs < targetMs) {
      low = mid + 1;
    } else {
      high = mid;
    }

    if (config.nodeVotesRequestDelayMs > 0) {
      await sleep(config.nodeVotesRequestDelayMs);
    }
  }

  return low;
}

async function fetchNodeVoteTxPage({ startHeight, endHeight, page, perPage }) {
  const queryText = `tx.height>=${startHeight} AND tx.height<=${endHeight} AND set_node_mimir.key EXISTS`;
  const payload = await fetchNodeVotesRpc('/tx_search', {
    query: `"${queryText}"`,
    page,
    per_page: perPage,
    order_by: '"asc"'
  });

  if (payload?.error) {
    throw new Error(payload.error?.data || payload.error?.message || 'tx_search failed');
  }

  return {
    total: Number(payload?.result?.total_count || 0),
    txs: Array.isArray(payload?.result?.txs) ? payload.result.txs : []
  };
}

export async function fetchNodeVoteTxs({ startHeight, endHeight }) {
  const perPage = Math.min(
    TX_SEARCH_MAX_PAGE_SIZE,
    Math.max(1, Number(config.nodeVotesTxSearchPageSize || TX_SEARCH_MAX_PAGE_SIZE))
  );
  const all = [];
  let total = 0;

  for (let page = 1; ; page += 1) {
    const result = await fetchNodeVoteTxPage({
      startHeight,
      endHeight,
      page,
      perPage
    });

    total = result.total;
    all.push(...result.txs);

    if (all.length >= total || result.txs.length === 0) {
      break;
    }

    if (config.nodeVotesRequestDelayMs > 0) {
      await sleep(config.nodeVotesRequestDelayMs);
    }
  }

  return {
    total,
    txs: all
  };
}

export async function fetchNodeVoteCosmosTxs({ startHeight, endHeight }, options = {}) {
  const limit = Math.min(
    TX_SEARCH_MAX_PAGE_SIZE,
    Math.max(1, Number(options.limit || config.nodeVotesTxSearchPageSize || TX_SEARCH_MAX_PAGE_SIZE))
  );
  const fetchPage = options.fetchPage || (async (page) => fetchThornodeApi(
    '/cosmos/tx/v1beta1/txs',
    {
      timeoutMs: 30_000,
      params: {
        query: `tx.height>=${startHeight} AND tx.height<=${endHeight} AND set_node_mimir.key EXISTS`,
        page,
        limit,
        order_by: 'ORDER_BY_ASC'
      }
    }
  ));
  const responses = [];
  let total = 0;

  for (let page = 1; ; page += 1) {
    const payload = await fetchPage(page);
    const pageResponses = Array.isArray(payload?.tx_responses) ? payload.tx_responses : [];
    total = Math.max(0, Number(payload?.total || 0));
    responses.push(...pageResponses);

    if (pageResponses.length === 0 || (total > 0 && responses.length >= total)) {
      break;
    }
    if (total === 0 && pageResponses.length < limit) {
      break;
    }

    if (config.nodeVotesRequestDelayMs > 0) {
      await sleep(config.nodeVotesRequestDelayMs);
    }
  }

  return {
    total: total || responses.length,
    txs: responses,
    rows: responses.flatMap(parseNodeVoteCosmosTxResponse)
  };
}

async function resolveNodeVoteHeightRange(startTime, endTime) {
  const status = await fetchNodeVotesRpcStatus();
  const bounds = statusHeights(status);
  const startHeight = await findNodeVotesStartHeight(startTime, status);
  const endMs = Date.parse(endTime || '');
  let endHeight = bounds.latestHeight;

  if (Number.isFinite(endMs) && bounds.latestTime && Date.parse(bounds.latestTime) > endMs) {
    endHeight = await findNodeVotesStartHeight(endTime, status);
  }

  return { startHeight, endHeight };
}

async function fetchNodeVoteRowsFromCosmos(startTime, endTime) {
  const { startHeight, endHeight } = await resolveNodeVoteHeightRange(startTime, endTime);
  const result = await fetchNodeVoteCosmosTxs({ startHeight, endHeight });
  return { ...result, startHeight, endHeight };
}

async function fetchNodeVoteRowsFromRpc(startTime, endTime) {
  const { startHeight, endHeight } = await resolveNodeVoteHeightRange(startTime, endTime);

  const txResult = await fetchNodeVoteTxs({ startHeight, endHeight });
  const heights = [...new Set(
    txResult.txs
      .map((tx) => Number(tx?.height || 0))
      .filter((height) => height > 0)
  )];
  const blockTimes = await fetchBlockTimesForHeights(heights);
  const rows = txResult.txs.flatMap((tx) => (
    parseNodeVoteTxSearchTx(tx, blockTimes.get(Number(tx?.height || 0)) || null)
  ));

  return {
    startHeight,
    endHeight,
    total: txResult.total,
    txs: txResult.txs,
    rows
  };
}

async function fetchBlockTimesForHeights(heights) {
  const times = new Map();

  await runConcurrent(
    heights,
    Math.max(1, config.nodeVotesBlockTimeConcurrency),
    async (height) => {
      try {
        const blockTime = await fetchNodeVotesBlockTime(height);
        if (blockTime) {
          times.set(height, blockTime);
        }
      } catch {
        times.set(height, null);
      }

      if (config.nodeVotesRequestDelayMs > 0) {
        await sleep(config.nodeVotesRequestDelayMs);
      }
    }
  );

  return times;
}

async function saveNodeVoteSyncState(client, payload) {
  await upsertRows(client, 'node_vote_sync_state', [
    {
      sync_key: SYNC_KEY,
      start_height: payload.startHeight,
      last_scanned_height: payload.endHeight,
      end_height: payload.endHeight,
      start_time: payload.startTime,
      end_time: payload.endTime,
      complete: true,
      updated_at: new Date().toISOString(),
      stats_json: payload.stats || {}
    }
  ], {
    conflictColumns: ['sync_key'],
    jsonColumns: ['stats_json']
  });
}

async function loadNodeVoteSyncState(client) {
  const { rows } = await client.query(
    `select sync_key, start_height, last_scanned_height, end_height, start_time, end_time, complete, stats_json
     from node_vote_sync_state
     where sync_key = $1
     limit 1`,
    [SYNC_KEY]
  );
  return rows[0] || null;
}

async function loadLatestStoredNodeVoteTime(client) {
  const { rows } = await client.query(
    `select max(block_time) as latest_time
     from node_votes`
  );
  return toIsoOrNull(rows[0]?.latest_time);
}

export async function runNodeVoteBackfill(client, options = {}) {
  const previousSyncState = await loadNodeVoteSyncState(client);
  const latestStoredTime = options.startTime ? '' : await loadLatestStoredNodeVoteTime(client);
  const window = resolveNodeVoteBackfillWindow({
    endTime: options.endTime,
    startTime: options.startTime,
    latestStoredTime
  });
  const latestTime = window.endTime;
  const startTime = window.startTime;

  let rows = [];
  let startHeight = 0;
  let endHeight = 0;
  let source = 'dune';
  let duneExecutionId = '';
  let duneError = '';
  let cosmosRestError = '';
  let txSearchTotal = 0;
  let txCount = 0;

  if (config.duneApiKey && config.nodeVotesDuneQueryId) {
    try {
      const duneResult = await fetchNodeVoteDuneRows(startTime, latestTime);
      rows = duneResult.rows;
      duneExecutionId = duneResult.executionId;
      txSearchTotal = rows.length;
      txCount = rows.length;
    } catch (error) {
      duneError = error?.message || String(error);
    }
  } else {
    duneError = !config.duneApiKey ? 'missing_dune_api_key' : 'missing_dune_node_votes_query_id';
  }

  if (rows.length === 0 && duneError) {
    try {
      const cosmosResult = await fetchNodeVoteRowsFromCosmos(startTime, latestTime);
      rows = cosmosResult.rows;
      startHeight = cosmosResult.startHeight;
      endHeight = cosmosResult.endHeight;
      txSearchTotal = cosmosResult.total;
      txCount = cosmosResult.txs.length;
      source = 'cosmos-rest';
    } catch (error) {
      cosmosRestError = error?.message || String(error);
      const rpcResult = await fetchNodeVoteRowsFromRpc(startTime, latestTime);
      rows = rpcResult.rows;
      startHeight = rpcResult.startHeight;
      endHeight = rpcResult.endHeight;
      txSearchTotal = rpcResult.total;
      txCount = rpcResult.txs.length;
      source = 'rpc';
    }
  }

  rows = await enrichRowsWithNodeMetadata(rows);

  const inserted = await upsertNodeVotes(client, rows);
  const heights = rows.map((row) => Number(row.height || 0)).filter((height) => height > 0);
  startHeight = heights.length ? Math.min(...heights) : startHeight;
  endHeight = heights.length ? Math.max(...heights) : endHeight;
  const stats = {
    mode: window.mode,
    source,
    dune_query_id: config.nodeVotesDuneQueryId || '',
    dune_execution_id: duneExecutionId,
    dune_error: duneError,
    cosmos_rest_error: cosmosRestError,
    latest_stored_time: window.latestStoredTime,
    lookback_days: window.lookbackDays,
    start_height: startHeight,
    end_height: endHeight,
    start_time: startTime,
    end_time: latestTime,
    tx_search_total: txSearchTotal,
    tx_count: txCount,
    event_count: rows.length,
    upserted: inserted,
    unique_vote_keys: new Set(rows.map((row) => row.mimir_key)).size,
    unique_nodes: new Set(rows.map((row) => row.node_address)).size,
    unique_operators: new Set(rows.map((row) => row.node_operator_address || row.node_address)).size
  };
  const displayStartTime = window.mode === 'rolling'
    ? sixMonthsAgo(new Date(latestTime)).toISOString()
    : startTime;
  let syncStartHeight = startHeight;
  if (window.mode === 'rolling') {
    const previousStartHeight = Number(previousSyncState?.start_height || 0);
    try {
      syncStartHeight = await findNodeVotesStartHeight(displayStartTime);
    } catch {
      syncStartHeight = previousStartHeight;
    }
  }

  await saveNodeVoteSyncState(client, {
    startHeight: syncStartHeight,
    endHeight,
    startTime: displayStartTime,
    endTime: latestTime,
    stats
  });

  return stats;
}

export async function writeNodeVoteListenerHeartbeat(payload) {
  await query('delete from node_vote_job_runs where job_name = $1', ['node-votes-ws-listener']);
  await query(
    `insert into node_vote_job_runs
      (job_name, started_at, finished_at, status, stats_json)
     values ($1, $2, $3, $4, $5)`,
    [
      'node-votes-ws-listener',
      payload.started_at,
      payload.finished_at,
      payload.status,
      payload.stats_json || {}
    ]
  );
}

export { SYNC_KEY as NODE_VOTES_SYNC_KEY };
