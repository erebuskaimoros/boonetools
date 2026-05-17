import WebSocket from 'ws';
import { config } from './lib/config.js';
import { sleep } from './lib/utils.js';
import {
  enrichRapidSwapHint,
  fetchRapidSwapPriceIndex,
  resolveRapidSwapHint,
  normalizeRapidSwapHint,
  RAPID_SWAP_CANDIDATE_STATUS
} from './shared/rapid-swaps.js';
import {
  upsertRapidSwap,
  upsertRapidSwapCandidate,
  writeRapidSwapListenerHeartbeat
} from './db/rapid-swaps-store.js';
import { getClient } from './db/pool.js';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 30000;
const PRICE_INDEX_TTL_MS = 60000;
const HEARTBEAT_INTERVAL_MS = 60000;
const STALL_CHECK_INTERVAL_MS = 30000;

let cachedPriceIndex = null;
let cachedPriceIndexAt = 0;
let lastBlockHeight = 0;
let lastBlockReceivedAt = 0;
let blocksProcessed = 0;
let heartbeatTimer = null;
let stallCheckTimer = null;
let ws = null;
let reconnectAttempt = 0;
let pingTimer = null;
let activeRpcWsIndex = 0;
let connectedAt = 0;

async function getCachedPriceIndex() {
  const now = Date.now();
  if (cachedPriceIndex && (now - cachedPriceIndexAt) < PRICE_INDEX_TTL_MS) {
    return cachedPriceIndex;
  }

  cachedPriceIndex = await fetchRapidSwapPriceIndex();
  cachedPriceIndexAt = now;
  return cachedPriceIndex;
}

async function sendHeartbeat() {
  const now = Date.now();
  const hasSeenBlock = lastBlockHeight > 0 && lastBlockReceivedAt > 0;
  const blockStallSeconds = hasSeenBlock
    ? Math.max(0, Math.floor((now - lastBlockReceivedAt) / 1000))
    : null;
  const streamFresh = hasSeenBlock && (now - lastBlockReceivedAt) <= config.rapidSwapsListenerBlockStallMs;
  const streamStatus = !hasSeenBlock
    ? 'starting'
    : streamFresh
      ? 'running'
      : 'stalled';

  await writeRapidSwapListenerHeartbeat({
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    status: 'running',
    stats_json: {
      last_block: lastBlockHeight,
      last_block_received_at: lastBlockReceivedAt > 0 ? new Date(lastBlockReceivedAt).toISOString() : null,
      block_stall_seconds: blockStallSeconds,
      stream_status: streamStatus,
      blocks_processed: blocksProcessed,
      uptime_seconds: Math.floor(process.uptime())
    }
  }).catch(() => {});
}

function startHeartbeat() {
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
}

function isBlockStreamStalled() {
  if (!connectedAt) {
    return false;
  }

  const referenceMs = lastBlockReceivedAt || connectedAt;
  return Date.now() - referenceMs > config.rapidSwapsListenerBlockStallMs;
}

function startStallWatchdog() {
  clearInterval(stallCheckTimer);
  stallCheckTimer = setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN || !isBlockStreamStalled()) {
      return;
    }

    const lastSeen = lastBlockReceivedAt > 0
      ? new Date(lastBlockReceivedAt).toISOString()
      : 'never';
    log(`WebSocket block stream stalled; last block ${lastBlockHeight || 'none'} seen ${lastSeen}. Reconnecting...`);
    rotateRpcWsUrl();
    ws.terminate();
  }, STALL_CHECK_INTERVAL_MS);
}

function stopStallWatchdog() {
  clearInterval(stallCheckTimer);
}

function tryDecode(value) {
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
    // Fall back to the raw value.
  }

  return value;
}

function log(message) {
  const timestamp = new Date().toISOString().slice(11, 19);
  console.log(`[${timestamp}] ${message}`);
}

function parseStreamingSwapEvents(events) {
  const rapidSwaps = [];

  for (const event of events || []) {
    if (event.type !== 'streaming_swap') {
      continue;
    }

    const attrs = {};
    for (const attribute of event.attributes || []) {
      attrs[tryDecode(attribute.key)] = tryDecode(attribute.value);
    }

    const interval = Number(attrs.interval);
    const quantity = Number(attrs.quantity);
    const count = Number(attrs.count);

    if (interval === 0 && quantity > 1 && count > 0 && count === quantity) {
      rapidSwaps.push({
        tx_id: attrs.tx_id || attrs.tx_hash || '',
        interval,
        quantity,
        count,
        last_height: Number(attrs.last_height) || 0,
        deposit: attrs.deposit || '',
        in: attrs.in || '',
        out: attrs.out || ''
      });
    }
  }

  return rapidSwaps;
}

async function processRapidSwap(detected, blockHeight, blockTime) {
  const initialHint = normalizeRapidSwapHint({
    source: 'ws',
    tx_id: detected.tx_id,
    observed_height: blockHeight || detected.last_height,
    last_height: detected.last_height,
    deposit: detected.deposit,
    in: detected.in,
    out: detected.out,
    raw_hint: detected
  });
  const hint = await enrichRapidSwapHint(initialHint).catch(() => initialHint);
  const reference = hint.tx_id || hint.hint_key;

  log(`Rapid swap detected: ${reference} (${detected.count}/${detected.quantity} subs, block ${blockHeight})`);

  const client = await getClient();
  try {
    await upsertRapidSwapCandidate(client, hint, {
      status: RAPID_SWAP_CANDIDATE_STATUS.PENDING
    });
  } finally {
    client.release();
  }

  await sleep(config.midgardDelayMs);

  const resolution = await resolveRapidSwapHint(hint, {
    priceIndex: await getCachedPriceIndex(),
    observedAt: blockTime || new Date().toISOString()
  }).catch((error) => ({
    row: null,
    hint,
    resolvedBy: '',
    error
  }));

  const updateClient = await getClient();
  try {
    if (!resolution.row) {
      const terminalStatus = resolution.terminal
        ? RAPID_SWAP_CANDIDATE_STATUS.ERROR
        : RAPID_SWAP_CANDIDATE_STATUS.PENDING;
      await upsertRapidSwapCandidate(updateClient, resolution.hint || hint, {
        status: terminalStatus,
        last_error: resolution.error?.message || 'Deferred to scheduler reconciliation'
      });
      if (resolution.terminal) {
        log(`  Ignored ${reference}: ${resolution.error?.message || 'not a rapid swap after THORNode reconciliation'}`);
      } else {
        log(`  Deferred ${reference} to scheduler reconciliation`);
      }
      return;
    }

    await upsertRapidSwap(updateClient, resolution.row);
    await upsertRapidSwapCandidate(updateClient, resolution.hint || hint, {
      status: RAPID_SWAP_CANDIDATE_STATUS.RESOLVED,
      resolved_tx_id: resolution.row.tx_id,
      resolved_at: new Date().toISOString(),
      last_error: ''
    });

    log(`  Upserted ${resolution.row.tx_id} via ${resolution.resolvedBy || 'listener'}: ${resolution.row.source_asset} -> ${resolution.row.target_asset}, $${resolution.row.input_estimated_usd}, ${resolution.row.streaming_count}/${resolution.row.streaming_quantity} subs, ${resolution.row.blocks_used} blocks`);
  } finally {
    updateClient.release();
  }
}

function handleMessage(message) {
  if (message.result && !message.result.data) {
    return;
  }

  const data = message.result?.data?.value;
  if (!data) {
    return;
  }

  const blockHeight = Number(data.block?.header?.height) || 0;
  const blockTime = String(data.block?.header?.time || '');
  if (blockHeight > 0) {
    lastBlockHeight = blockHeight;
    lastBlockReceivedAt = Date.now();
    blocksProcessed += 1;
  }

  const events = data.result_finalize_block?.events || data.result_end_block?.events || [];
  const rapidSwaps = parseStreamingSwapEvents(events);
  const seen = new Set();

  for (const detected of rapidSwaps) {
    if (seen.has(detected.tx_id)) {
      continue;
    }
    seen.add(detected.tx_id);
    processRapidSwap(detected, blockHeight, blockTime).catch((error) => {
      log(`Error processing ${detected.tx_id}: ${error.message}`);
    });
  }
}

function scheduleReconnect() {
  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt),
    RECONNECT_MAX_MS
  );
  reconnectAttempt += 1;
  log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempt})...`);
  setTimeout(connect, delay);
}

function getRpcWsUrls() {
  return Array.isArray(config.rpcWsUrls) && config.rpcWsUrls.length > 0
    ? config.rpcWsUrls
    : [config.rpcWsUrl];
}

function getActiveRpcWsUrl() {
  const urls = getRpcWsUrls();
  return urls[activeRpcWsIndex % urls.length];
}

function rotateRpcWsUrl() {
  const urls = getRpcWsUrls();
  if (urls.length > 1) {
    activeRpcWsIndex = (activeRpcWsIndex + 1) % urls.length;
  }
}

function connect() {
  const rpcWsUrl = getActiveRpcWsUrl();
  let opened = false;
  log(`Connecting to ${rpcWsUrl}...`);
  ws = new WebSocket(rpcWsUrl, {
    headers: {
      'x-client-id': 'RuneTools'
    }
  });

  ws.on('open', () => {
    log('Connected. Subscribing to NewBlock events...');
    opened = true;
    connectedAt = Date.now();
    reconnectAttempt = 0;

    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'subscribe',
      id: 1,
      params: { query: "tm.event='NewBlock'" }
    }));

    startHeartbeat();
    startStallWatchdog();

    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, PING_INTERVAL_MS);
  });

  ws.on('message', (data) => {
    try {
      handleMessage(JSON.parse(data.toString()));
    } catch {
      // Ignore parse failures for non-JSON frames.
    }
  });

  ws.on('close', (code, reason) => {
    log(`WebSocket closed: ${code} ${reason || ''}`);
    clearInterval(pingTimer);
    stopHeartbeat();
    stopStallWatchdog();
    connectedAt = 0;
    if (!opened) {
      rotateRpcWsUrl();
    }
    scheduleReconnect();
  });

  ws.on('error', (error) => {
    log(`WebSocket error: ${error.message}`);
  });
}

export function shutdownRapidSwapListener(signal) {
  log(`Received ${signal}, shutting down...`);
  clearInterval(pingTimer);
  stopHeartbeat();
  stopStallWatchdog();
  if (ws) {
    ws.removeAllListeners();
    ws.close();
  }
}

export function startRapidSwapListener() {
  process.on('SIGINT', () => {
    shutdownRapidSwapListener('SIGINT');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shutdownRapidSwapListener('SIGTERM');
    process.exit(0);
  });

  log('Rapid Swap WebSocket Listener starting');
  log(`RPC URLs: ${getRpcWsUrls().join(', ')}`);
  log(`Midgard delay: ${config.midgardDelayMs}ms`);
  connect();
}
