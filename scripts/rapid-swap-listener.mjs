#!/usr/bin/env node

/**
 * Rapid Swap WebSocket Listener
 *
 * Connects to THORChain's Tendermint RPC WebSocket, subscribes to NewBlock events,
 * and watches for streaming_swap completions with interval=0 (rapid swaps).
 * When detected, fetches the full action from Midgard and upserts to Supabase.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/rapid-swap-listener.mjs
 *
 * Environment:
 *   SUPABASE_URL              - Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - Supabase service role key
 *   RPC_WS_URL                - Tendermint RPC WebSocket URL (default: wss://rpc.thorchain.network/websocket)
 *   MIDGARD_DELAY_MS          - Delay before querying Midgard after detection (default: 5000)
 */

import WebSocket from 'ws';
import { createClient } from '@supabase/supabase-js';
import {
  normalizeRapidSwapAction,
  buildAssetUsdIndex
} from '../src/lib/rapid-swaps/model.js';

// ---- Config ----

const RPC_WS_URL = process.env.RPC_WS_URL || 'wss://rpc.thorchain.network/websocket';
const MIDGARD_DELAY_MS = Number(process.env.MIDGARD_DELAY_MS) || 5000;

const MIDGARD_BASES = [
  'https://midgard.thorchain.network/v2',
  'https://midgard.liquify.com/v2'
];

const THORNODE_BASES = [
  'https://thornode.thorchain.network',
  'https://thornode.thorchain.liquify.com'
];

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 30000;

// ---- Supabase ----

function createSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

const supabase = createSupabase();

// ---- Fetch helpers ----

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'x-client-id': 'BooneTools', ...headers }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) throw new Error(`Challenge response for ${url}`);
  return res.json();
}

async function fetchWithFallback(bases, path) {
  let lastErr;
  for (const base of bases) {
    try {
      return await fetchJson(`${base}${path}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function fetchMidgardAction(txId) {
  const data = await fetchWithFallback(MIDGARD_BASES, `/actions?txid=${txId}`);
  const actions = data?.actions || [];
  return actions[0] || null;
}

async function fetchPriceIndex() {
  const [network, pools] = await Promise.all([
    fetchWithFallback(THORNODE_BASES, '/thorchain/network'),
    fetchWithFallback(THORNODE_BASES, '/thorchain/pools')
  ]);
  return buildAssetUsdIndex(network, Array.isArray(pools) ? pools : []);
}

// ---- Heartbeat ----

const HEARTBEAT_INTERVAL_MS = 60000;
let lastBlockHeight = 0;
let blocksProcessed = 0;
let heartbeatTimer = null;

async function sendHeartbeat() {
  try {
    // Delete old heartbeats, insert fresh one
    await supabase
      .from('rapid_swap_job_runs')
      .delete()
      .eq('job_name', 'rapid-swaps-ws-listener');

    await supabase
      .from('rapid_swap_job_runs')
      .insert({
        job_name: 'rapid-swaps-ws-listener',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        status: 'running',
        stats_json: {
          last_block: lastBlockHeight,
          blocks_processed: blocksProcessed,
          uptime_seconds: Math.floor(process.uptime())
        }
      });
  } catch (_) {}
}

function startHeartbeat() {
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
}

// ---- Supabase upsert ----

async function upsertRapidSwap(row) {
  const { error } = await supabase
    .from('rapid_swaps')
    .upsert(row, { onConflict: 'tx_id' });
  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
}

// ---- Event parsing ----

function parseStreamingSwapEvents(events) {
  const rapidSwaps = [];

  for (const event of events || []) {
    if (event.type !== 'streaming_swap') continue;

    const attrs = {};
    for (const attr of event.attributes || []) {
      // CometBFT may base64-encode keys/values
      const key = tryDecode(attr.key);
      const value = tryDecode(attr.value);
      attrs[key] = value;
    }

    const interval = Number(attrs.interval);
    const quantity = Number(attrs.quantity);
    const count = Number(attrs.count);

    if (interval === 0 && quantity > 1 && count > 0 && count === quantity) {
      rapidSwaps.push({
        tx_id: attrs.tx_id || '',
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

function tryDecode(val) {
  if (!val) return '';
  // If it looks like base64, decode it
  try {
    if (/^[A-Za-z0-9+/]+=*$/.test(val) && val.length > 1) {
      const decoded = Buffer.from(val, 'base64').toString('utf8');
      // Only use decoded if it's printable
      if (/^[\x20-\x7E]*$/.test(decoded) && decoded.length > 0) {
        return decoded;
      }
    }
  } catch (_) {}
  return val;
}

// ---- Process detected rapid swap ----

async function processRapidSwap(detected, blockHeight) {
  const { tx_id } = detected;
  if (!tx_id) return;

  log(`Rapid swap detected: ${tx_id} (${detected.count}/${detected.quantity} subs, block ${blockHeight})`);

  // Wait for Midgard to index — rapid swaps complete fast but Midgard
  // needs time to index and mark status=success
  await sleep(MIDGARD_DELAY_MS);

  let row = null;
  let retries = 10;

  while (retries > 0) {
    const action = await fetchMidgardAction(tx_id).catch(() => null);

    if (action) {
      const priceIndex = await fetchPriceIndex().catch(() => ({ prices: new Map(), runePriceUsd: 0 }));
      row = normalizeRapidSwapAction(action, {
        observedAt: new Date().toISOString(),
        priceIndex
      });

      if (row) break;

      // Action exists but didn't pass filter (likely status != success yet)
      log(`  ${tx_id} status=${action?.status || '?'}, waiting for completion...`);
    } else {
      log(`  Midgard not ready for ${tx_id}...`);
    }

    retries--;
    if (retries > 0) {
      await sleep(10000);
    }
  }

  if (!row) {
    log(`  Failed to record ${tx_id} after retries, skipping`);
    return;
  }

  // Remove raw_action to save space (it's large)
  delete row.raw_action;

  // Upsert to Supabase
  await upsertRapidSwap(row);
  log(`  Upserted ${tx_id}: ${row.source_asset} -> ${row.target_asset}, $${row.input_estimated_usd}, ${row.streaming_count}/${row.streaming_quantity} subs, ${row.blocks_used} blocks`);
}

// ---- WebSocket connection ----

let ws = null;
let reconnectAttempt = 0;
let pingTimer = null;

function connect() {
  log(`Connecting to ${RPC_WS_URL}...`);

  ws = new WebSocket(RPC_WS_URL);

  ws.on('open', () => {
    log('Connected. Subscribing to NewBlock events...');
    reconnectAttempt = 0;

    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'subscribe',
      id: 1,
      params: { query: "tm.event='NewBlock'" }
    }));

    startHeartbeat();

    // Ping to keep alive
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, PING_INTERVAL_MS);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(msg);
    } catch (err) {
      // Ignore parse errors (ping/pong frames etc)
    }
  });

  ws.on('close', (code, reason) => {
    log(`WebSocket closed: ${code} ${reason || ''}`);
    clearInterval(pingTimer);
    stopHeartbeat();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    log(`WebSocket error: ${err.message}`);
  });
}

function handleMessage(msg) {
  // Subscription confirmation
  if (msg.result && !msg.result.data) return;

  const data = msg.result?.data?.value;
  if (!data) return;

  const blockHeight = Number(data.block?.header?.height) || 0;
  if (blockHeight > 0) {
    lastBlockHeight = blockHeight;
    blocksProcessed++;
  }

  // Events can be in result_finalize_block (CometBFT 0.38+) or result_end_block
  const events =
    data.result_finalize_block?.events ||
    data.result_end_block?.events ||
    [];

  const rapidSwaps = parseStreamingSwapEvents(events);

  // Deduplicate by tx_id within a block
  const seen = new Set();
  for (const detected of rapidSwaps) {
    if (seen.has(detected.tx_id)) continue;
    seen.add(detected.tx_id);
    // Process async — don't block the event loop
    processRapidSwap(detected, blockHeight).catch((err) => {
      log(`Error processing ${detected.tx_id}: ${err.message}`);
    });
  }
}

function scheduleReconnect() {
  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt),
    RECONNECT_MAX_MS
  );
  reconnectAttempt++;
  log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempt})...`);
  setTimeout(connect, delay);
}

// ---- Utilities ----

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Shutdown ----

function shutdown(signal) {
  log(`Received ${signal}, shutting down...`);
  clearInterval(pingTimer);
  if (ws) {
    ws.removeAllListeners();
    ws.close();
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---- Start ----

log('Rapid Swap WebSocket Listener starting');
log(`RPC: ${RPC_WS_URL}`);
log(`Midgard delay: ${MIDGARD_DELAY_MS}ms`);
connect();
