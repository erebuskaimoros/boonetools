import { getClient } from './db/pool.js';
import { config } from './lib/config.js';
import { createTendermintBlockStream } from './lib/tendermint-block-stream.js';
import {
  parseRujiraReservePaymentBlock,
  saveParsedRujiraReservePaymentBlock,
  writeRujiraReservePaymentListenerHeartbeat
} from './shared/rujira-reserve-payments.js';

const HEARTBEAT_INTERVAL_MS = 60000;

let blockStream = null;
let heartbeatTimer = null;
let startedAt = new Date().toISOString();
let blocksProcessed = 0;
let reserveEventsSeen = 0;

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
  await writeRujiraReservePaymentListenerHeartbeat({
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
      blocks_processed: blocksProcessed,
      reserve_events_seen: reserveEventsSeen,
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

async function processBlock({ data, blockHeight, blockTime }) {
  blocksProcessed += 1;
  const parsed = parseRujiraReservePaymentBlock(blockHeight, data, {
    blockTime: blockTime || '',
    source: 'ws'
  });
  if (!parsed.events.length) {
    return;
  }

  reserveEventsSeen += parsed.events.length;
  const client = await getClient();
  try {
    await saveParsedRujiraReservePaymentBlock(client, blockHeight, data, {
      blockTime: blockTime || '',
      source: 'ws'
    });
  } finally {
    client.release();
  }

  const totalRune = parsed.events.reduce((sum, event) => sum + event.amount_rune, 0);
  log(`Reserve payment detected: ${parsed.events.length} event(s), ${totalRune.toFixed(8)} RUNE at block ${blockHeight}`);
}

export function shutdownRujiraReservePaymentListener(signal) {
  log(`Received ${signal}, shutting down...`);
  stopHeartbeat();
  blockStream?.stop();
  blockStream = null;
}

export function startRujiraReservePaymentListener() {
  process.on('SIGINT', () => {
    shutdownRujiraReservePaymentListener('SIGINT');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shutdownRujiraReservePaymentListener('SIGTERM');
    process.exit(0);
  });

  startedAt = new Date().toISOString();
  log('Rujira Reserve Payment WebSocket Listener starting');
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
    onProcessingError: (error) => {
      log(`Error processing block: ${error.message}`);
    },
    onBlock: processBlock
  });
  blockStream.start();
}

startRujiraReservePaymentListener();
