#!/usr/bin/env node

/**
 * Rapid Swap WebSocket Listener
 *
 * Connects to THORChain's Tendermint RPC WebSocket, subscribes to NewBlock events,
 * and watches for streaming_swap completions with interval=0 (rapid swaps).
 * When detected, it durably records a reconciliation hint and attempts an immediate
 * Midgard resolution, leaving authoritative catch-up to the scheduler.
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
  enrichRapidSwapHint,
  fetchRapidSwapPriceIndex,
  resolveRapidSwapHint
} from '../src/lib/rapid-swaps/backend.js';
import {
  normalizeRapidSwapHint,
  RAPID_SWAP_CANDIDATE_STATUS
} from '../src/lib/rapid-swaps/reconciliation.js';

// ---- Config ----

const RPC_WS_URL = process.env.RPC_WS_URL || 'wss://rpc.thorchain.network/websocket';
const MIDGARD_DELAY_MS = Number(process.env.MIDGARD_DELAY_MS) || 5000;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 30000;
const PRICE_INDEX_TTL_MS = 60000;

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

// ---- Shared recovery state ----

let cachedPriceIndex = null;
let cachedPriceIndexAt = 0;

async function getCachedPriceIndex() {
  const now = Date.now();
  if (cachedPriceIndex && (now - cachedPriceIndexAt) < PRICE_INDEX_TTL_MS) {
    return cachedPriceIndex;
  }

  cachedPriceIndex = await fetchRapidSwapPriceIndex();
  cachedPriceIndexAt = now;
  return cachedPriceIndex;
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

async function upsertRapidSwapCandidate(hintInput, patch = {}) {
  const now = new Date().toISOString();
  const candidate = normalizeRapidSwapHint({
    ...hintInput,
    ...patch
  });
  const { data: existing, error: existingError } = await supabase
    .from('rapid_swap_candidates')
    .select('status,attempts,resolved_tx_id,resolved_at')
    .eq('hint_key', candidate.hint_key)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Supabase candidate lookup failed: ${existingError.message}`);
  }

  const preserveResolved = existing?.status === RAPID_SWAP_CANDIDATE_STATUS.RESOLVED
    && candidate.status !== RAPID_SWAP_CANDIDATE_STATUS.RESOLVED;

  const { error } = await supabase
    .from('rapid_swap_candidates')
    .upsert(
      {
        hint_key: candidate.hint_key,
        source: candidate.source,
        tx_id: candidate.tx_id,
        source_address: candidate.source_address,
        memo: candidate.memo,
        observed_height: candidate.observed_height,
        last_height: candidate.last_height,
        status: preserveResolved ? existing.status : candidate.status,
        attempts: preserveResolved
          ? Number(existing.attempts || candidate.attempts || 0)
          : candidate.attempts,
        last_seen_at: now,
        next_retry_at: patch.next_retry_at || now,
        resolved_tx_id: patch.resolved_tx_id || existing?.resolved_tx_id || '',
        resolved_at: patch.resolved_at || existing?.resolved_at || null,
        last_error: preserveResolved ? null : (patch.last_error || null),
        raw_hint: candidate.raw_hint
      },
      { onConflict: 'hint_key' }
    );

  if (error) {
    throw new Error(`Supabase candidate upsert failed: ${error.message}`);
  }
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
      const txId = attrs.tx_id || attrs.tx_hash || '';
      if (!txId) {
        log(`  WARN: streaming_swap completed (${count}/${quantity} subs) but no tx_id — attrs: ${JSON.stringify(attrs).slice(0, 200)}`);
      }
      rapidSwaps.push({
        tx_id: txId,
        interval,
        quantity,
        count,
        last_height: Number(attrs.last_height) || 0,
        deposit: attrs.deposit || '',
        in: attrs.in || '',
        out: attrs.out || ''
      });
    } else if (interval === 0 && quantity > 1 && count > 0 && count < quantity) {
      // In-progress rapid swap sub — ignore, will catch on completion
    } else if (interval === 0 && quantity > 1) {
      log(`  SKIP: streaming_swap interval=0 qty=${quantity} count=${count} tx=${attrs.tx_id || '?'}`);
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

  await upsertRapidSwapCandidate(hint, {
    status: RAPID_SWAP_CANDIDATE_STATUS.PENDING
  });

  // Wait for Midgard to index — rapid swaps complete fast but Midgard
  // needs time to index and mark status=success
  await sleep(MIDGARD_DELAY_MS);

  const resolution = await resolveRapidSwapHint(hint, {
    priceIndex: await getCachedPriceIndex()
  }).catch((error) => ({
    row: null,
    hint,
    resolvedBy: '',
    error
  }));

  if (!resolution.row) {
    await upsertRapidSwapCandidate(resolution.hint || hint, {
      status: RAPID_SWAP_CANDIDATE_STATUS.PENDING,
      last_error: resolution.error?.message || 'Deferred to scheduler reconciliation'
    });
    log(`  Deferred ${reference} to scheduler reconciliation`);
    return;
  }

  // Upsert to Supabase
  await upsertRapidSwap(resolution.row);
  await upsertRapidSwapCandidate(resolution.hint || hint, {
    status: RAPID_SWAP_CANDIDATE_STATUS.RESOLVED,
    resolved_tx_id: resolution.row.tx_id,
    resolved_at: new Date().toISOString(),
    last_error: ''
  });

  log(`  Upserted ${resolution.row.tx_id} via ${resolution.resolvedBy || 'listener'}: ${resolution.row.source_asset} -> ${resolution.row.target_asset}, $${resolution.row.input_estimated_usd}, ${resolution.row.streaming_count}/${resolution.row.streaming_quantity} subs, ${resolution.row.blocks_used} blocks`);
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
