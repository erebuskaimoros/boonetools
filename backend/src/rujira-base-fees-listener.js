import { getClient } from './db/pool.js';
import { config } from './lib/config.js';
import { createTendermintBlockStream } from './lib/tendermint-block-stream.js';
import {
  processRujiraBaseFeeBlockHeight,
  writeRujiraBaseFeeListenerHeartbeat
} from './shared/rujira-base-fees.js';

const HEARTBEAT_INTERVAL_MS = 60000;

let blockStream = null;
let heartbeatTimer = null;
let startedAt = new Date().toISOString();
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

async function sendHeartbeat() {
  const stream = blockStream?.getState() || {};
  await writeRujiraBaseFeeListenerHeartbeat({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status: 'running',
    stats_json: {
      last_block: stream.lastBlockHeight || 0,
      last_block_received_at: stream.lastBlockReceivedAt > 0
        ? new Date(stream.lastBlockReceivedAt).toISOString()
        : null,
      block_stall_seconds: stream.blockStallSeconds ?? null,
      stream_status: stream.streamStatus || 'starting',
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
  heartbeatTimer = null;
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

function enqueueBlock({ blockHeight, blockTime }) {
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

export function shutdownRujiraBaseFeeListener(signal) {
  log(`Received ${signal}, shutting down...`);
  stopHeartbeat();
  blockStream?.stop();
  blockStream = null;
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
  blockStream = createTendermintBlockStream({
    urls: getRpcWsUrls(),
    stallMs: config.rapidSwapsListenerBlockStallMs,
    log,
    onOpen: () => {
      log('Connected. Subscribed to NewBlock events.');
      startHeartbeat();
    },
    onClose: ({ code, reason }) => {
      log(`WebSocket closed: ${code} ${reason || ''}`);
      stopHeartbeat();
    },
    onError: (error) => {
      log(`WebSocket error: ${error.message}`);
    },
    onBlock: enqueueBlock
  });
  blockStream.start();
}

startRujiraBaseFeeListener();
