import { upsertRows } from '../db/sql.js';
import { config } from '../lib/config.js';
import { sleep } from '../lib/utils.js';
import { mergeVoteScanCoverage, voteScanWindow } from './node-vote-acquisition.js';
import {
  fetchNodeVoteTxs,
  fetchNodeVotesBlockTime,
  resolveNodeVoteBackfillWindow,
  resolveNodeVoteHeightRange,
  tryDecode
} from './node-votes.js';

export const PROTOCOL_MIMIR_SYNC_KEY = 'protocol-mimir-backfill';
export const PROTOCOL_MIMIR_EVENT_QUERY = 'set_mimir.key EXISTS';

const COLUMNS = [
  'event_key',
  'tx_id',
  'height',
  'block_time',
  'event_index',
  'mimir_key',
  'mimir_value',
  'change_source',
  'source_label',
  'security_message',
  'source',
  'raw_event',
  'observed_at',
  'updated_at'
];

function toIsoOrNull(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function attributesFor(event) {
  const attrs = {};
  for (const attribute of event?.attributes || []) {
    const key = tryDecode(attribute?.key);
    if (key) attrs[key] = tryDecode(attribute?.value);
  }
  return attrs;
}

function eventKey({ txId, height, txIndex, eventIndex, attrs }) {
  if (txId) return `${txId}:${eventIndex}`;
  return [height || 0, txIndex ?? 'block', eventIndex, attrs.key || '', attrs.value || ''].join(':');
}

export function parseProtocolMimirChanges(events, envelope = {}) {
  const decoded = (events || []).map((event, eventIndex) => ({
    event,
    eventIndex,
    type: String(event?.type || ''),
    attrs: attributesFor(event)
  }));
  const validatorVoteChanges = new Set(
    decoded
      .filter((row) => row.type === 'set_node_mimir')
      .map((row) => [
        String(row.attrs.key || '').trim().toUpperCase(),
        String(row.attrs.value ?? '').trim()
      ].join('\u0000'))
      .filter(Boolean)
  );
  const securityMessage = decoded
    .filter((row) => row.type === 'security')
    .map((row) => String(row.attrs.msg || row.attrs.message || row.attrs.reason || '').trim())
    .filter(Boolean)
    .join('; ');
  const height = Number(envelope.height || envelope.blockHeight || 0) || 0;
  const txId = String(envelope.txId || envelope.tx_id || '').trim().toUpperCase();
  const txIndex = Number.isFinite(Number(envelope.txIndex)) ? Number(envelope.txIndex) : null;
  const blockTime = toIsoOrNull(envelope.blockTime);
  const now = envelope.observedAt || new Date().toISOString();

  return decoded.flatMap(({ eventIndex, type, attrs }) => {
    if (type !== 'set_mimir') return [];
    const mimirKey = String(attrs.key || '').trim().toUpperCase();
    const mimirValue = String(attrs.value ?? '').trim();
    if (!mimirKey) return [];
    const isValidatorConsensus = validatorVoteChanges.has(`${mimirKey}\u0000${mimirValue}`);
    const isSafetyEvent = Boolean(securityMessage);
    const changeSource = isValidatorConsensus
      ? 'validator_consensus'
      : (isSafetyEvent ? 'protocol_safety' : 'protocol_direct');
    const sourceLabel = isValidatorConsensus
      ? 'Validator consensus event'
      : (isSafetyEvent ? 'Protocol safety event' : 'Direct protocol event');
    return [{
      event_key: eventKey({ txId, height, txIndex, eventIndex, attrs }),
      tx_id: txId,
      height,
      block_time: blockTime,
      event_index: eventIndex,
      mimir_key: mimirKey,
      mimir_value: mimirValue,
      change_source: changeSource,
      source_label: sourceLabel,
      security_message: securityMessage,
      source: envelope.source || 'rpc',
      raw_event: {
        type,
        attributes: attrs,
        tx_index: txIndex,
        security_events: decoded
          .filter((row) => row.type === 'security')
          .map((row) => row.attrs)
      },
      observed_at: now,
      updated_at: new Date().toISOString()
    }];
  });
}

export function parseProtocolMimirTxSearchTx(tx, blockTime = null) {
  return parseProtocolMimirChanges(tx?.tx_result?.events || [], {
    txId: tx?.hash || '',
    height: Number(tx?.height || 0),
    txIndex: Number(tx?.index || 0),
    blockTime,
    source: 'rpc'
  });
}

export async function upsertProtocolMimirChanges(client, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  await upsertRows(client, 'protocol_mimir_changes', rows, {
    columns: COLUMNS,
    conflictColumns: ['event_key'],
    updateColumns: COLUMNS.filter((column) => column !== 'event_key'),
    jsonColumns: ['raw_event'],
    chunkSize: 250
  });
  return rows.length;
}

async function loadSyncState(client) {
  const result = await client.query(
    `select start_height, last_scanned_height, end_height, start_time, end_time, complete, stats_json
     from node_vote_sync_state where sync_key = $1 limit 1`,
    [PROTOCOL_MIMIR_SYNC_KEY]
  );
  return result.rows[0] || null;
}

async function saveSyncState(client, payload) {
  await upsertRows(client, 'node_vote_sync_state', [{
    sync_key: PROTOCOL_MIMIR_SYNC_KEY,
    start_height: payload.startHeight,
    last_scanned_height: payload.endHeight,
    end_height: payload.endHeight,
    start_time: payload.startTime,
    end_time: payload.endTime,
    complete: Boolean(payload.historyComplete),
    updated_at: new Date().toISOString(),
    stats_json: payload.stats
  }], {
    conflictColumns: ['sync_key'],
    jsonColumns: ['stats_json']
  });
}

async function blockTimesFor(heights, options = {}) {
  const times = new Map();
  const fetchTime = options.fetchBlockTime || fetchNodeVotesBlockTime;
  for (const height of heights) {
    const value = await fetchTime(height, options.transportOptions);
    if (!value) throw new Error(`Missing protocol Mimir block time at ${height}`);
    times.set(height, value);
    if (config.nodeVotesRequestDelayMs > 0) await sleep(config.nodeVotesRequestDelayMs);
  }
  return times;
}

export async function runProtocolMimirBackfill(client, options = {}) {
  const previous = await loadSyncState(client);
  const fullWindow = resolveNodeVoteBackfillWindow({ endTime: options.endTime });
  const previousCoverage = previous?.stats_json?.scan_coverage || (previous?.complete ? {
    startTime: previous.start_time, startHeight: Number(previous.start_height),
    endTime: previous.end_time, endHeight: Number(previous.last_scanned_height || previous.end_height)
  } : null);
  const window = voteScanWindow({
    startTime: options.startTime,
    endTime: fullWindow.endTime,
    fullStartTime: fullWindow.startTime,
    previous: previousCoverage
  });
  const resolveRange = options.resolveHeightRange || resolveNodeVoteHeightRange;
  const fetchTxs = options.fetchTxs || fetchNodeVoteTxs;
  const explicitStartHeight = Math.trunc(Number(options.startHeight || 0));
  const explicitEndHeight = Math.trunc(Number(options.endHeight || 0));
  const confirmedRange = explicitStartHeight > 0 && explicitEndHeight >= explicitStartHeight
    ? { startHeight: explicitStartHeight, endHeight: explicitEndHeight }
    : await resolveRange(window.startTime, window.endTime, { client, startHeight: window.startHeight });
  const { startHeight, endHeight } = confirmedRange;
  const transportOptions = {
    sharedCooldown: true,
    cooldownScope: 'protocol-mimir-history',
    client, cooldownClient: client,
    ...(confirmedRange.rpcUrls ? { rpcUrls: confirmedRange.rpcUrls } : {})
  };
  const result = await fetchTxs(
    { startHeight, endHeight },
    {
      eventQueries: [PROTOCOL_MIMIR_EVENT_QUERY],
      transportOptions
    }
  );
  const heights = [...new Set(
    result.txs.map((tx) => Number(tx?.height || 0)).filter((height) => height > 0)
  )];
  const times = await blockTimesFor(heights, { ...options, transportOptions });
  const rows = result.txs.flatMap((tx) => (
    parseProtocolMimirTxSearchTx(tx, times.get(Number(tx?.height || 0)) || null)
  ));
  const upserted = await upsertProtocolMimirChanges(client, rows);
  const coverage = mergeVoteScanCoverage(previousCoverage, {
    startTime: window.startTime, endTime: window.endTime, ...confirmedRange
  });
  const stats = {
    scan_complete: true, history_complete: coverage.historyComplete, scan_coverage: coverage,
    mode: window.mode,
    start_height: startHeight,
    end_height: endHeight,
    start_time: window.startTime,
    end_time: window.endTime,
    tx_search_total: result.total,
    tx_count: result.txs.length,
    event_count: rows.length,
    upserted,
    unique_mimir_keys: new Set(rows.map((row) => row.mimir_key)).size
  };
  await saveSyncState(client, {
    startHeight: window.mode === 'incremental'
      ? (Number(previous?.start_height || 0) || startHeight)
      : startHeight,
    endHeight,
    startTime: window.mode === 'incremental'
      ? (previous?.start_time || window.startTime)
      : window.startTime,
    endTime: coverage.endTime,
    historyComplete: coverage.historyComplete,
    stats
  });
  return stats;
}
