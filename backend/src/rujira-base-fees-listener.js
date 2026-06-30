import WebSocket from 'ws';
import { getClient } from './db/pool.js';
import { config } from './lib/config.js';
import {
  processRujiraBaseFeeBlockHeight,
  writeRujiraBaseFeeListenerHeartbeat
} from './shared/rujira-base-fees.js';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 60000;
const STALL_CHECK_INTERVAL_MS = 30000;

let ws = null;
let reconnectAttempt = 0;
let pingTimer = null;
let heartbeatTimer = null;
let stallCheckTimer = null;
let activeRpcWsIndex = 0;
let connectedAt = 0;
let startedAt = new Date().toISOString();
let lastBlockHeight = 0;
let lastBlockReceivedAt = 0;
let blocksReceived = 0;
let blocksProcessed = 0;
let queuedBlocks = 0;
let matchedFeeEventsSeen = 0;
let includedFeeEventsSeen = 0;
let excludedFeeEventsSeen = 0;
let lastFeeBlock = 0;
let lastFeeBlockAt = null;
let rpcErrors = 0;
let lastError = '';
let processQueue = Promise.resolve();

function log(message) {
  const timestamp = new Date().toISOString().slice(11, 19);
  console.log(`[${timestamp}] ${message}`);
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

function isBlockStreamStalled() {
  if (!connectedAt) {
    return false;
  }

  const referenceMs = lastBlockReceivedAt || connectedAt;
  return Date.now() - referenceMs > config.rapidSwapsListenerBlockStallMs;
}

function getBlockEnvelope(data) {
  const blockHeight = Number(data?.block?.header?.height) || 0;
  const rawBlockTime = String(data?.block?.header?.time || '');
  const blockTime = rawBlockTime && Number.isFinite(Date.parse(rawBlockTime))
    ? new Date(rawBlockTime).toISOString()
    : null;

  return {
    blockHeight,
    blockTime
  };
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

  await writeRujiraBaseFeeListenerHeartbeat({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status: 'running',
    stats_json: {
      last_block: lastBlockHeight,
      last_block_received_at: lastBlockReceivedAt > 0 ? new Date(lastBlockReceivedAt).toISOString() : null,
      block_stall_seconds: blockStallSeconds,
      stream_status: streamStatus,
      blocks_received: blocksReceived,
      blocks_processed: blocksProcessed,
      queued_blocks: queuedBlocks,
      matched_fee_events_seen: matchedFeeEventsSeen,
      included_fee_events_seen: includedFeeEventsSeen,
      excluded_fee_events_seen: excludedFeeEventsSeen,
      last_fee_block: lastFeeBlock || null,
      last_fee_block_at: lastFeeBlockAt,
      rpc_errors: rpcErrors,
      last_error: lastError || null,
      uptime_seconds: Math.floor(process.uptime())
    }
  }).catch(() => {});
}

function startHeartbeat() {
  sendHeartbeat();
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
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

async function processBlock(blockHeight, blockTime) {
  const client = await getClient();
  try {
    const parsed = await processRujiraBaseFeeBlockHeight(client, blockHeight, {
      blockTime,
      source: 'ws',
      attempts: 1,
      persistEmpty: false
    });

    blocksProcessed += 1;
    lastError = '';

    if (!parsed.events.length) {
      return;
    }

    const includedEvents = parsed.events.filter((event) => event.included).length;
    const excludedEvents = parsed.events.length - includedEvents;
    matchedFeeEventsSeen += parsed.events.length;
    includedFeeEventsSeen += includedEvents;
    excludedFeeEventsSeen += excludedEvents;
    lastFeeBlock = blockHeight;
    lastFeeBlockAt = blockTime || new Date().toISOString();

    const totalRune = parsed.events.reduce((sum, event) => sum + event.liquidity_fee_rune, 0);
    log(`Generated base-fee event(s): ${parsed.events.length} total, ${includedEvents} included, ${totalRune.toFixed(8)} RUNE at block ${blockHeight}`);
  } catch (error) {
    rpcErrors += 1;
    lastError = String(error?.message || error || '').slice(0, 240);
    throw error;
  } finally {
    client.release();
  }
}

function enqueueBlock(data) {
  const { blockHeight, blockTime } = getBlockEnvelope(data);
  if (blockHeight <= 0) {
    return;
  }

  lastBlockHeight = blockHeight;
  lastBlockReceivedAt = Date.now();
  blocksReceived += 1;
  queuedBlocks += 1;

  processQueue = processQueue
    .catch(() => {})
    .then(() => processBlock(blockHeight, blockTime))
    .catch((error) => {
      log(`Error processing block ${blockHeight}: ${error.message}`);
    })
    .finally(() => {
      queuedBlocks = Math.max(0, queuedBlocks - 1);
    });
}

function handleMessage(message) {
  if (message.result && !message.result.data) {
    return;
  }

  const data = message.result?.data?.value;
  if (!data) {
    return;
  }

  enqueueBlock(data);
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

function connect() {
  const rpcWsUrl = getActiveRpcWsUrl();
  let opened = false;
  log(`Connecting to ${rpcWsUrl}...`);
  ws = new WebSocket(rpcWsUrl, {
    headers: {
      'x-client-id': 'BooneTools'
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

export function shutdownRujiraBaseFeeListener(signal) {
  log(`Received ${signal}, shutting down...`);
  clearInterval(pingTimer);
  stopHeartbeat();
  stopStallWatchdog();
  if (ws) {
    ws.removeAllListeners();
    ws.close();
  }
}

export function startRujiraBaseFeeListener() {
  process.on('SIGINT', () => {
    shutdownRujiraBaseFeeListener('SIGINT');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shutdownRujiraBaseFeeListener('SIGTERM');
    process.exit(0);
  });

  startedAt = new Date().toISOString();
  log('Rujira Base Fee WebSocket Listener starting');
  log(`RPC URLs: ${getRpcWsUrls().join(', ')}`);
  connect();
}

startRujiraBaseFeeListener();
