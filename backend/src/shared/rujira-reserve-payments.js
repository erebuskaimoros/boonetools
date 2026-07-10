import { createHash } from 'node:crypto';
import { query } from '../db/pool.js';
import { upsertRows } from '../db/sql.js';
import { config } from '../lib/config.js';
import { safeNumber, sleep, toIsoString } from '../lib/utils.js';
import { executeDuneQueryRows, formatDuneDateTime, summarizeDuneError } from './dune.js';
import { fetchMidgard, fetchMidgardActions, isMidgardRateLimitError } from './midgard.js';

const ACTION_SYNC_KEY = 'rujira-reserve-payment-actions:v1';
const SCHEDULE_SYNC_KEY = 'rujira-reserve-payment-schedule:v1';
const ACTION_PAGE_LIMIT = 50;
const RPC_REQUEST_TIMEOUT_MS = 10000;
const CANONICAL_RESERVE_PAYMENT_EVENTS_CTE = `
with canonical_events as (
  select *
  from (
    select event.*,
           row_number() over (
             partition by height, tx_id, amount_base, sender, recipient, memo
             order by
               case when source = 'dune' then 0 else 1 end,
               block_time desc,
               updated_at desc,
               event_key desc
           ) as canonical_rank
    from rujira_reserve_payment_events event
  ) ranked
  where canonical_rank = 1
)`;

export const BASE_LAYER_REVENUE_COLLECTOR =
  'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr';
export const TC_RESERVE_MODULE =
  'thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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
    // Use the raw value below.
  }

  return String(value);
}

function attrsToObject(event) {
  const attrs = {};
  for (const attr of event?.attributes || []) {
    const key = tryDecode(attr?.key);
    if (!key) continue;
    attrs[key] = tryDecode(attr?.value);
  }
  return attrs;
}

function compactEvent(event) {
  const attrs = attrsToObject(event);
  const keys = ['amount', 'recipient', 'sender', 'from', 'to', 'memo', 'id', 'coin', 'mode', 'chain'];
  return {
    type: event?.type || '',
    attrs: Object.fromEntries(keys.filter((key) => attrs[key] !== undefined).map((key) => [key, attrs[key]]))
  };
}

function parseDateNs(ns) {
  try {
    if (ns === undefined || ns === null || ns === '') return null;
    return new Date(Number(BigInt(String(ns)) / 1_000_000n));
  } catch {
    return null;
  }
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

function startOfUtcWeek(value) {
  const source = value instanceof Date ? value : new Date(value);
  const date = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate()));
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  return date;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function baseRuneToNumber(value) {
  try {
    return Number(BigInt(String(value || '0'))) / 1e8;
  } catch {
    return 0;
  }
}

function roundNumber(value, decimals = 8) {
  const numeric = Number(value) || 0;
  const factor = 10 ** decimals;
  return Math.round((numeric + Number.EPSILON) * factor) / factor;
}

function toIsoOrNull(value) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeBaseUnitAmount(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) {
    return '';
  }

  try {
    return BigInt(text).toString();
  } catch {
    return '';
  }
}

function parseExplicitRuneAmount(value) {
  const text = String(value ?? '').trim();
  const compact = text.match(/^(\d+)rune$/i);
  if (compact) {
    return normalizeBaseUnitAmount(compact[1]);
  }

  const spaced = text.match(/^(\d+)\s+THOR\.RUNE$/i);
  if (spaced) {
    return normalizeBaseUnitAmount(spaced[1]);
  }

  return '';
}

function parseReserveRuneAmount(attrs) {
  const coinText = String(attrs?.coin ?? '').trim();
  const coinAmount = parseExplicitRuneAmount(coinText);
  const amountWithDenom = parseExplicitRuneAmount(attrs?.amount);
  const bareAmount = normalizeBaseUnitAmount(attrs?.amount);

  // A reserve event may carry the amount in `amount` or `coin`, but any
  // supplied coin must explicitly identify RUNE and agree with `amount`.
  if (coinText && !coinAmount) {
    return '';
  }
  if (coinAmount) {
    if ((amountWithDenom && amountWithDenom !== coinAmount) || (bareAmount && bareAmount !== coinAmount)) {
      return '';
    }
    return coinAmount;
  }

  return amountWithDenom;
}

function extractFinalizeEvents(payload) {
  const result = payload?.result || payload || {};
  if (Array.isArray(result.finalize_block_events)) {
    return result.finalize_block_events;
  }
  if (Array.isArray(result.result_finalize_block?.events)) {
    return result.result_finalize_block.events;
  }
  if (Array.isArray(payload?.result_finalize_block?.events)) {
    return payload.result_finalize_block.events;
  }
  return [];
}

function getBlockHeight(payload, fallbackHeight = 0) {
  return Number(
    fallbackHeight ||
    payload?.block?.header?.height ||
    payload?.result?.height ||
    payload?.result?.block?.header?.height ||
    0
  ) || 0;
}

function getBlockTime(payload, fallbackTime = null) {
  const value =
    fallbackTime ||
    payload?.block?.header?.time ||
    payload?.result?.block?.header?.time ||
    null;
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isTargetTransfer(attrs) {
  return (
    attrs.sender === BASE_LAYER_REVENUE_COLLECTOR &&
    attrs.recipient === TC_RESERVE_MODULE &&
    Boolean(parseExplicitRuneAmount(attrs.amount))
  );
}

function isTargetReserve(attrs) {
  return (
    (attrs.from === BASE_LAYER_REVENUE_COLLECTOR || attrs.contributor_address === BASE_LAYER_REVENUE_COLLECTOR) &&
    attrs.to === TC_RESERVE_MODULE &&
    attrs.memo === 'RESERVE' &&
    Boolean(parseReserveRuneAmount(attrs))
  );
}

function takeMatchingReserve(reserveRows, amountBase) {
  const index = reserveRows.findIndex((row) => !row.used && row.amountBase === amountBase);
  if (index === -1) {
    return null;
  }
  reserveRows[index].used = true;
  return reserveRows[index];
}

function buildEventKey({ height, index, txId, amountBase }) {
  return sha256([height, index, txId || '', amountBase, BASE_LAYER_REVENUE_COLLECTOR, TC_RESERVE_MODULE].join('|'));
}

function normalizePaymentEvent({ height, blockTime, index, amountBase, transfer, reserve, source }) {
  const reserveAttrs = reserve?.attrs || {};
  const reserveAmountBase = reserve?.amountBase || parseReserveRuneAmount(reserveAttrs);
  if (!reserve || !reserveAmountBase || reserveAmountBase !== amountBase) {
    return null;
  }

  const txId = reserveAttrs.id || '';
  return {
    event_key: buildEventKey({ height, index, txId, amountBase }),
    height,
    block_time: blockTime,
    tx_id: txId,
    sender: BASE_LAYER_REVENUE_COLLECTOR,
    recipient: TC_RESERVE_MODULE,
    memo: reserveAttrs.memo,
    amount_base: amountBase,
    amount_rune: baseRuneToNumber(amountBase),
    rune_price_usd: 0,
    amount_usd: 0,
    coin: reserveAttrs.coin || `${amountBase} THOR.RUNE`,
    source: source || 'unknown',
    raw_event: {
      transfer: transfer?.event ? compactEvent(transfer.event) : null,
      reserve: reserve?.event ? compactEvent(reserve.event) : null
    }
  };
}

export function parseRujiraReservePaymentBlock(height, blockPayload, options = {}) {
  const events = extractFinalizeEvents(blockPayload);
  const blockHeight = getBlockHeight(blockPayload, height);
  const blockTime = getBlockTime(blockPayload, options.blockTime);
  const source = options.source || 'rpc';
  const transfers = [];
  const reserves = [];

  for (const [index, event] of events.entries()) {
    const attrs = attrsToObject(event);
    if (event?.type === 'transfer' && isTargetTransfer(attrs)) {
      transfers.push({ index, attrs, event, amountBase: parseExplicitRuneAmount(attrs.amount) });
    } else if (event?.type === 'reserve' && isTargetReserve(attrs)) {
      reserves.push({ index, attrs, event, amountBase: parseReserveRuneAmount(attrs), used: false });
    }
  }

  const parsedEvents = [];
  let matchedTransferCount = 0;
  for (const transfer of transfers) {
    const amountBase = transfer.amountBase;
    const reserve = takeMatchingReserve(reserves, amountBase);
    if (!reserve) {
      continue;
    }

    const payment = normalizePaymentEvent({
      height: blockHeight,
      blockTime,
      index: transfer.index,
      amountBase,
      transfer,
      reserve,
      source
    });
    if (!payment) {
      continue;
    }

    matchedTransferCount += 1;
    parsedEvents.push(payment);
  }

  let reserveOnlyEventCount = 0;
  for (const reserve of reserves) {
    if (reserve.used) {
      continue;
    }

    const payment = normalizePaymentEvent({
      height: blockHeight,
      blockTime,
      index: reserve.index,
      amountBase: reserve.amountBase,
      transfer: null,
      reserve,
      source
    });
    if (!payment) {
      continue;
    }

    reserveOnlyEventCount += 1;
    parsedEvents.push(payment);
  }

  return {
    events: parsedEvents.filter((event) => event.height > 0 && event.block_time && event.amount_rune > 0),
    scan: {
      height: blockHeight,
      transfer_event_count: transfers.length,
      reserve_event_count: reserves.length,
      matched_transfer_event_count: matchedTransferCount,
      unmatched_transfer_event_count: transfers.length - matchedTransferCount,
      reserve_only_event_count: reserveOnlyEventCount,
      matched_event_count: parsedEvents.length,
      source
    }
  };
}

export async function saveRujiraReservePaymentEvents(client, events) {
  if (!events.length) {
    return 0;
  }

  await upsertRows(client, 'rujira_reserve_payment_events', events, {
    conflictColumns: ['event_key'],
    jsonColumns: ['raw_event']
  });
  await pruneDuplicateRujiraReservePaymentEvents(client);

  return events.length;
}

export async function pruneDuplicateRujiraReservePaymentEvents(client) {
  const { rows } = await client.query(
    `with ranked as (
       select event_key,
              row_number() over (
                partition by height, tx_id, amount_base, sender, recipient, memo
                order by
                  case when source = 'dune' then 0 else 1 end,
                  block_time desc,
                  updated_at desc,
                  event_key desc
              ) as canonical_rank
       from rujira_reserve_payment_events
     ),
     deleted as (
       delete from rujira_reserve_payment_events event
       using ranked
       where event.event_key = ranked.event_key
         and ranked.canonical_rank > 1
       returning event.event_key
     )
     select count(*)::bigint as deleted_count
     from deleted`
  );
  return Number(rows[0]?.deleted_count) || 0;
}

export async function markRujiraReservePaymentBlockFetched(client, height, payload = {}) {
  await upsertRows(client, 'rujira_reserve_payment_blocks', [{
    height: Number(height),
    block_time: payload.block_time || null,
    source: payload.source || 'ws',
    status: 'fetched',
    attempts: payload.attempts || 0,
    next_retry_at: new Date().toISOString(),
    error: '',
    scan_json: payload.scan_json || {},
    fetched_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }], {
    conflictColumns: ['height'],
    jsonColumns: ['scan_json'],
    updateColumns: ['block_time', 'source', 'status', 'next_retry_at', 'error', 'scan_json', 'fetched_at', 'updated_at']
  });
}

export async function saveParsedRujiraReservePaymentBlock(client, height, blockPayload, options = {}) {
  const parsed = parseRujiraReservePaymentBlock(height, blockPayload, options);
  await saveRujiraReservePaymentEvents(client, parsed.events);
  await markRujiraReservePaymentBlockFetched(client, Number(height), {
    block_time: parsed.events[0]?.block_time || options.blockTime || null,
    source: options.source || 'rpc',
    attempts: options.attempts || 0,
    scan_json: parsed.scan
  });
  return parsed;
}

async function loadSyncState(client, syncKey) {
  const { rows } = await client.query(
    `select sync_key, next_page_token, next_scheduled_height, complete, rate_limited_until, updated_at, stats_json
     from rujira_reserve_payment_sync_state
     where sync_key = $1
     limit 1`,
    [syncKey]
  );
  return rows[0] || null;
}

async function saveSyncState(client, syncKey, payload) {
  await upsertRows(client, 'rujira_reserve_payment_sync_state', [{
    sync_key: syncKey,
    next_page_token: payload.next_page_token || '',
    next_scheduled_height: Number(payload.next_scheduled_height) || 0,
    complete: Boolean(payload.complete),
    rate_limited_until: payload.rate_limited_until || null,
    updated_at: new Date().toISOString(),
    stats_json: payload.stats_json || {}
  }], {
    conflictColumns: ['sync_key'],
    jsonColumns: ['stats_json']
  });
}

function isCooldownActive(syncState) {
  const untilMs = Date.parse(String(syncState?.rate_limited_until || ''));
  return Number.isFinite(untilMs) && untilMs > Date.now();
}

async function putCooldown(client, syncKey, error) {
  const syncState = await loadSyncState(client, syncKey);
  const until = new Date(Date.now() + config.rujiraReservePaymentsRateLimitCooldownMs).toISOString();
  await saveSyncState(client, syncKey, {
    next_page_token: syncState?.next_page_token || '',
    next_scheduled_height: Number(syncState?.next_scheduled_height) || 0,
    complete: Boolean(syncState?.complete),
    rate_limited_until: until,
    stats_json: {
      ...(syncState?.stats_json || {}),
      last_error: error?.message || String(error),
      rate_limited_at: new Date().toISOString()
    }
  });
  return until;
}

async function upsertCandidateBlocks(client, rows) {
  const candidates = rows
    .filter((row) => Number(row.height) > 0)
    .map((row) => ({
      height: Number(row.height),
      block_time: row.block_time || null,
      source: row.source || 'backfill',
      status: 'pending',
      attempts: 0,
      next_retry_at: new Date().toISOString(),
      error: '',
      scan_json: row.scan_json || {},
      fetched_at: null,
      updated_at: new Date().toISOString()
    }));

  if (!candidates.length) {
    return 0;
  }

  await upsertRows(client, 'rujira_reserve_payment_blocks', candidates, {
    conflictColumns: ['height'],
    jsonColumns: ['scan_json'],
    updateColumns: ['block_time', 'source', 'updated_at']
  });

  return candidates.length;
}

export async function ingestRujiraReservePaymentMidgardCandidates(client, options = {}) {
  const syncState = await loadSyncState(client, ACTION_SYNC_KEY);
  if (isCooldownActive(syncState)) {
    return {
      skipped: true,
      reason: 'provider_cooldown',
      rate_limited_until: toIsoString(syncState.rate_limited_until)
    };
  }

  const alreadyComplete = Boolean(syncState?.complete);
  let nextPageToken = alreadyComplete ? '' : String(syncState?.next_page_token || '');
  let complete = alreadyComplete;
  const maxPages = alreadyComplete
    ? 1
    : Math.max(0, Number(options.maxPages ?? config.rujiraReservePaymentsMidgardMaxPages) || 0);
  const stats = {
    pages: 0,
    actions: 0,
    heights: 0,
    next_page_token: nextPageToken,
    complete
  };

  for (let page = 0; page < maxPages; page += 1) {
    const payload = await fetchMidgardActions({
      address: BASE_LAYER_REVENUE_COLLECTOR,
      type: 'contract',
      limit: ACTION_PAGE_LIMIT,
      ...(nextPageToken ? { nextPageToken } : { offset: 0 })
    });
    const actions = (payload.actions || [])
      .filter((action) => action?.metadata?.contract?.contractType === 'wasm-rujira-revenue/run')
      .map((action) => ({
        height: Number(action.height),
        block_time: parseDateNs(action.date)?.toISOString() || null,
        source: 'midgard-action',
        scan_json: {
          denom: action?.metadata?.contract?.attributes?.denom || '',
          action_date: action.date || ''
        }
      }))
      .filter((row) => row.height > 0);

    stats.pages += 1;
    stats.actions += actions.length;
    stats.heights += await upsertCandidateBlocks(client, actions);

    nextPageToken = payload?.meta?.nextPageToken || '';
    if (!nextPageToken) {
      complete = true;
      break;
    }

    if (config.rujiraReservePaymentsRequestDelayMs > 0) {
      await sleep(config.rujiraReservePaymentsRequestDelayMs);
    }
  }

  await saveSyncState(client, ACTION_SYNC_KEY, {
    next_page_token: alreadyComplete ? '' : nextPageToken,
    next_scheduled_height: 0,
    complete,
    rate_limited_until: null,
    stats_json: {
      ...stats,
      next_page_token: alreadyComplete ? '' : nextPageToken,
      complete,
      mode: alreadyComplete ? 'head_refresh' : 'backfill'
    }
  });

  return {
    ...stats,
    next_page_token: alreadyComplete ? '' : nextPageToken,
    complete,
    mode: alreadyComplete ? 'head_refresh' : 'backfill'
  };
}

function createHttpError(message, details = {}) {
  const error = new Error(message);
  error.status = details.status || 0;
  error.url = details.url || '';
  error.body = details.body || '';
  return error;
}

function isProviderRateLimit(error) {
  return Boolean(
    isMidgardRateLimitError(error) ||
    error?.status === 429 ||
    /HTTP 429|Too Many Requests|daily request limit|rate.?limit|rune pouch is empty/i.test(String(error?.message || '')) ||
    /daily request limit|rate.?limit|rune pouch is empty/i.test(String(error?.body || ''))
  );
}

async function fetchJsonFromBases(bases, pathname, params = {}) {
  const queryString = new URLSearchParams(params).toString();
  const path = queryString ? `${pathname}?${queryString}` : pathname;
  let lastError = null;

  for (const base of bases) {
    const url = `${String(base || '').replace(/\/$/, '')}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RPC_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw createHttpError(`RPC error: ${response.status} ${response.statusText} for ${path}`, {
          status: response.status,
          url,
          body: text.slice(0, 240)
        });
      }

      try {
        return JSON.parse(text);
      } catch {
        throw createHttpError(`Invalid JSON from ${url}`, { url, body: text.slice(0, 240) });
      }
    } catch (error) {
      lastError = error;
      if (isProviderRateLimit(error)) {
        throw error;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error(`Unable to fetch ${path}`);
}

async function fetchRpcBlockResults(height) {
  return fetchJsonFromBases(config.rujiraReservePaymentsRpcUrls, '/block_results', {
    height: String(height)
  });
}

async function fetchRpcBlock(height) {
  return fetchJsonFromBases(config.rujiraReservePaymentsRpcUrls, '/block', {
    height: String(height)
  });
}

function getBlockTimeFromBlockPayload(payload) {
  const value = payload?.result?.block?.header?.time || '';
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function fetchRpcStatus() {
  const payload = await fetchJsonFromBases(config.rujiraReservePaymentsRpcUrls, '/status');
  return Number(payload?.result?.sync_info?.latest_block_height || 0);
}

export async function ingestRujiraReservePaymentScheduledCandidates(client, options = {}) {
  const syncState = await loadSyncState(client, SCHEDULE_SYNC_KEY);
  const schedule = Math.max(1, Number(config.rujiraReservePaymentsScheduleBlocks) || 101);
  const startHeight = Number(syncState?.next_scheduled_height || 0) || Number(config.rujiraReservePaymentsStartHeight);
  const maxHeights = Math.max(0, Number(options.maxHeights ?? config.rujiraReservePaymentsCandidateMaxHeights) || 0);
  const latestHeight = await fetchRpcStatus();
  const stopHeight = Math.max(0, latestHeight - config.rujiraReservePaymentsHeadLagBlocks);
  const rows = [];

  for (let height = startHeight; height > 0 && height <= stopHeight && rows.length < maxHeights; height += schedule) {
    rows.push({
      height,
      source: 'scheduled-cadence',
      scan_json: {
        schedule,
        start_height: Number(config.rujiraReservePaymentsStartHeight)
      }
    });
  }

  const inserted = await upsertCandidateBlocks(client, rows);
  const nextHeight = rows.length ? rows.at(-1).height + schedule : startHeight;
  await saveSyncState(client, SCHEDULE_SYNC_KEY, {
    next_page_token: '',
    next_scheduled_height: nextHeight,
    complete: stopHeight > 0 && nextHeight > stopHeight,
    rate_limited_until: null,
    stats_json: {
      latest_height: latestHeight,
      stop_height: stopHeight,
      selected: rows.length,
      inserted,
      schedule
    }
  });

  return {
    latest_height: latestHeight,
    stop_height: stopHeight,
    selected: rows.length,
    inserted,
    next_scheduled_height: nextHeight,
    complete: stopHeight > 0 && nextHeight > stopHeight
  };
}

async function loadPendingBlocks(client, limit) {
  const { rows } = await client.query(
    `select height, block_time, source, attempts
     from rujira_reserve_payment_blocks
     where status = 'pending'
        or (status = 'error' and next_retry_at <= now())
     order by height asc
     limit $1`,
    [Math.max(1, limit)]
  );
  return rows;
}

function retryDelaySeconds(attempts) {
  const attempt = Math.max(1, Number(attempts) || 1);
  return Math.min(30 * 60, 60 * Math.pow(2, Math.min(attempt - 1, 5)));
}

async function markBlockError(client, row, error) {
  const attempts = Number(row.attempts || 0) + 1;
  await client.query(
    `update rujira_reserve_payment_blocks
     set status = 'error',
         attempts = $2,
         next_retry_at = now() + ($3::text || ' seconds')::interval,
         error = $4,
         updated_at = now()
     where height = $1`,
    [
      Number(row.height),
      attempts,
      retryDelaySeconds(attempts),
      String(error?.message || error || '').slice(0, 500)
    ]
  );
}

export async function processRujiraReservePaymentBlocks(client, options = {}) {
  const limit = Math.max(0, Number(options.limit ?? config.rujiraReservePaymentsBlockMaxHeights) || 0);
  if (limit <= 0) {
    return {
      selected: 0,
      fetched: 0,
      errored: 0,
      events: 0
    };
  }

  const blocks = await loadPendingBlocks(client, limit);
  const stats = {
    selected: blocks.length,
    fetched: 0,
    errored: 0,
    events: 0
  };

  for (const row of blocks) {
    try {
      let blockTime = row.block_time ? new Date(row.block_time).toISOString() : null;
      if (!blockTime) {
        const blockPayload = await fetchRpcBlock(row.height);
        blockTime = getBlockTimeFromBlockPayload(blockPayload);
      }
      const payload = await fetchRpcBlockResults(row.height);
      const parsed = await saveParsedRujiraReservePaymentBlock(client, Number(row.height), payload, {
        blockTime,
        source: row.source || 'backfill',
        attempts: Number(row.attempts || 0) + 1
      });
      stats.fetched += 1;
      stats.events += parsed.events.length;
    } catch (error) {
      stats.errored += 1;
      if (isProviderRateLimit(error)) {
        await putCooldown(client, ACTION_SYNC_KEY, error);
        throw error;
      }
      await markBlockError(client, row, error);
    }

    if (config.rujiraReservePaymentsRequestDelayMs > 0) {
      await sleep(config.rujiraReservePaymentsRequestDelayMs);
    }
  }

  return stats;
}

async function fetchRunePriceDays(fromTs, count) {
  const params = new URLSearchParams({
    interval: 'day',
    from: String(fromTs),
    count: String(Math.max(1, Math.min(400, count)))
  });
  const payload = await fetchMidgard(`/history/rune?${params.toString()}`, {
    bases: config.rujiraReservePaymentsMidgardUrls,
    validateResponse: (_path, data) => !Array.isArray(data?.intervals)
  });

  return payload.intervals.map((row) => ({
    day_start: dateKey(new Date(Number(row.startTime) * 1000)),
    day_end: dateKey(new Date(Number(row.endTime) * 1000)),
    rune_price_usd: Number(row.runePriceUSD) || 0,
    source_json: row
  }));
}

export async function refreshRujiraReservePaymentPrices(client) {
  const { rows } = await client.query(
    `select min(block_time) as min_time, max(block_time) as max_time
     from rujira_reserve_payment_events
     where block_time is not null`
  );
  const minTime = rows[0]?.min_time;
  const maxTime = rows[0]?.max_time;
  if (!minTime || !maxTime) {
    return {
      days: 0,
      priced_events: 0
    };
  }

  const firstDay = new Date(Date.UTC(
    new Date(minTime).getUTCFullYear(),
    new Date(minTime).getUTCMonth(),
    new Date(minTime).getUTCDate()
  ));
  const lastDay = new Date(Date.UTC(
    new Date(maxTime).getUTCFullYear(),
    new Date(maxTime).getUTCMonth(),
    new Date(maxTime).getUTCDate()
  ));
  const dayCount = Math.ceil((lastDay.getTime() - firstDay.getTime()) / (24 * 60 * 60 * 1000)) + 2;
  const priceRows = await fetchRunePriceDays(Math.floor(firstDay.getTime() / 1000), dayCount);
  await upsertRows(client, 'rujira_reserve_payment_rune_price_days', priceRows, {
    conflictColumns: ['day_start'],
    jsonColumns: ['source_json']
  });

  const updateResult = await client.query(
    `update rujira_reserve_payment_events event
     set rune_price_usd = price.rune_price_usd,
         amount_usd = event.amount_rune * price.rune_price_usd,
         updated_at = now()
     from rujira_reserve_payment_rune_price_days price
     where event.block_time is not null
       and date_trunc('day', event.block_time at time zone 'UTC')::date = price.day_start`
  );

  return {
    days: priceRows.length,
    priced_events: Number(updateResult.rowCount) || 0
  };
}

function normalizeWeeklyRows(rows) {
  let cumulativeRune = 0;
  let cumulativeUsd = 0;
  return rows.map((row) => {
    const paymentRune = Number(row.payment_rune) || 0;
    const paymentUsd = Number(row.payment_usd) || 0;
    cumulativeRune += paymentRune;
    cumulativeUsd += paymentUsd;
    const weekStart = dateKey(row.week_start);
    return {
      week_start: weekStart,
      week_end: dateKey(addDays(new Date(`${weekStart}T00:00:00.000Z`), 7)),
      payments: Number(row.payments) || 0,
      payment_rune: roundNumber(paymentRune, 8),
      rune_price_usd: Number(row.rune_price_usd) || 0,
      payment_usd: roundNumber(paymentUsd, 8),
      cumulative_rune: roundNumber(cumulativeRune, 8),
      cumulative_usd: roundNumber(cumulativeUsd, 8)
    };
  });
}

async function fetchDashboardStats(client) {
  const [blocks, events, actionSync, scheduleSync, listener] = await Promise.all([
    client.query(
      `select status, count(*)::bigint as count
       from rujira_reserve_payment_blocks
       group by status`
    ),
    client.query(
      `${CANONICAL_RESERVE_PAYMENT_EVENTS_CTE}
       select count(*)::bigint as event_count,
              count(distinct height)::bigint as active_heights,
              coalesce(sum(amount_rune), 0) as payment_rune,
              coalesce(sum(amount_usd), 0) as payment_usd,
              min(height)::bigint as min_height,
              max(height)::bigint as max_height,
              max(updated_at) as updated_at
       from canonical_events`
    ),
    client.query(
      `select next_page_token, complete, rate_limited_until, updated_at, stats_json
       from rujira_reserve_payment_sync_state
       where sync_key = $1
       limit 1`,
      [ACTION_SYNC_KEY]
    ),
    client.query(
      `select next_scheduled_height, complete, updated_at, stats_json
       from rujira_reserve_payment_sync_state
       where sync_key = $1
       limit 1`,
      [SCHEDULE_SYNC_KEY]
    ),
    client.query(
      `select finished_at, status, stats_json
       from rujira_reserve_payment_job_runs
       where job_name = 'rujira-reserve-payments-ws-listener'
       order by finished_at desc nulls last, started_at desc
       limit 1`
    )
  ]);

  return {
    blockCounts: Object.fromEntries(blocks.rows.map((row) => [row.status, Number(row.count) || 0])),
    events: events.rows[0] || {},
    actionSync: actionSync.rows[0] || null,
    scheduleSync: scheduleSync.rows[0] || null,
    listener: listener.rows[0] || null
  };
}

export async function getRujiraReservePaymentsDashboardPayload(client = { query }) {
  const [weeklyResult, recentResult, stats] = await Promise.all([
    client.query(
      `${CANONICAL_RESERVE_PAYMENT_EVENTS_CTE}
       select date_trunc('week', block_time at time zone 'UTC')::date as week_start,
              count(*)::bigint as payments,
              coalesce(sum(amount_rune), 0) as payment_rune,
              coalesce(sum(amount_usd), 0) as payment_usd,
              case
                when coalesce(sum(amount_rune), 0) > 0
                  then coalesce(sum(amount_usd), 0) / sum(amount_rune)
                else coalesce(avg(nullif(rune_price_usd, 0)), 0)
              end as rune_price_usd
       from canonical_events
       where block_time is not null
       group by 1
       order by 1 asc`
    ),
    client.query(
      `${CANONICAL_RESERVE_PAYMENT_EVENTS_CTE}
       select event_key, height, block_time, tx_id, amount_base, amount_rune, rune_price_usd, amount_usd, coin, source
       from canonical_events
       order by block_time asc, height asc`
    ),
    fetchDashboardStats(client)
  ]);

  const weekly = normalizeWeeklyRows(weeklyResult.rows);
  const blockCounts = stats.blockCounts || {};
  const totalBlocks = Object.values(blockCounts).reduce((sum, count) => sum + count, 0);
  const eventStats = stats.events || {};
  const sourceProvider = String(stats.actionSync?.stats_json?.source || '') === 'dune' ? 'dune' : 'legacy';
  const pendingBlockCount = blockCounts.pending || 0;
  const errorBlockCount = blockCounts.error || 0;

  return {
    schema_version: 2,
    meta: {
      generatedAt: new Date().toISOString(),
      source: sourceProvider === 'dune' ? 'dune-query-backed-postgres' : 'boonetools-postgres',
      scope: 'DB-backed explicit Rujira Base Layer collector transfers into the TC Reserve module.',
      method: sourceProvider === 'dune'
        ? 'Execute the BooneTools Rujira Reserve Payments Dune source query over thorchain.defi_reserve_events, then upsert explicit Base Layer collector -> TC Reserve RESERVE events into the local dashboard cache.'
        : 'Listen to THORChain NewBlock websocket events and upsert Base Layer collector -> TC Reserve transfer events. Price each event with Midgard daily RUNE/USD for the deposit block time. Scheduled/Midgard backfill only queues missed candidate heights, then RPC block_results confirms the same transfer event.',
      caveat:
        'This tracks explicit app-layer revenue-share distributions into the TC Reserve. USD totals are historical value at dispersal time, not current mark-to-market RUNE value. It is separate from generated base-layer swap fees and from Midgard system income.',
      priceBasis: sourceProvider === 'dune'
        ? 'amount_rune × Dune thorchain.defi_daily_pool_stats daily RUNE/USD for each Reserve deposit block_time'
        : 'amount_rune × Midgard daily RUNE/USD for each Reserve deposit block_time',
      reserveCollector: BASE_LAYER_REVENUE_COLLECTOR,
      reserveTarget: TC_RESERVE_MODULE,
      eventCount: Number(eventStats.event_count) || 0,
      activeHeightCount: Number(eventStats.active_heights) || 0,
      actionCount: Number(stats.actionSync?.stats_json?.actions || 0),
      blockCount: totalBlocks,
      pendingBlockCount,
      fetchedBlockCount: blockCounts.fetched || 0,
      errorBlockCount,
      backfillComplete: sourceProvider === 'dune'
        ? true
        : Boolean(stats.scheduleSync?.complete) && pendingBlockCount === 0 && errorBlockCount === 0,
      nextScheduledHeight: Number(stats.scheduleSync?.next_scheduled_height) || 0,
      nextPageToken: stats.actionSync?.next_page_token || '',
      rateLimitedUntil: toIsoString(stats.actionSync?.rate_limited_until),
      totalPaymentRune: roundNumber(eventStats.payment_rune, 8),
      totalPaymentUsd: roundNumber(eventStats.payment_usd, 8),
      firstHeight: Number(eventStats.min_height) || 0,
      latestHeight: Number(eventStats.max_height) || 0,
      updatedAt: toIsoString(eventStats.updated_at || stats.scheduleSync?.updated_at || stats.actionSync?.updated_at),
      wsListener: stats.listener
        ? {
            status: stats.listener.status || '',
            lastHeartbeat: toIsoString(stats.listener.finished_at),
            stats: stats.listener.stats_json || {}
          }
        : null
    },
    weekly,
    events: recentResult.rows.map((row) => ({
      event_key: String(row.event_key || ''),
      height: Number(row.height) || 0,
      date: toIsoString(row.block_time),
      id: String(row.tx_id || ''),
      amountBase: Number(row.amount_base) || 0,
      amountRune: roundNumber(row.amount_rune, 8),
      runePriceUsd: roundNumber(row.rune_price_usd, 8),
      amountUsd: roundNumber(row.amount_usd, 8),
      coin: String(row.coin || ''),
      source: String(row.source || '')
    }))
  };
}

export async function writeRujiraReservePaymentListenerHeartbeat(payload = {}) {
  await upsertRows({ query }, 'rujira_reserve_payment_job_runs', [{
    id: '00000000-0000-0000-0000-000000000014',
    job_name: 'rujira-reserve-payments-ws-listener',
    started_at: payload.started_at || new Date().toISOString(),
    finished_at: payload.finished_at || new Date().toISOString(),
    status: payload.status || 'running',
    error: payload.error || null,
    stats_json: payload.stats_json || {}
  }], {
    conflictColumns: ['id'],
    jsonColumns: ['stats_json']
  });
}

function normalizeDuneReservePaymentRow(row) {
  const eventKey = String(row?.event_key || '').trim();
  const blockTime = toIsoOrNull(row?.block_time);
  const height = Math.max(0, Math.trunc(safeNumber(row?.height, 0)));
  const sender = String(row?.sender || '').trim();
  const recipient = String(row?.recipient || '').trim();
  const memo = String(row?.memo || '').trim();
  const amountBase = normalizeBaseUnitAmount(row?.amount_base);
  const coin = String(row?.coin || '').trim();
  const coinAmountBase = parseExplicitRuneAmount(coin);

  if (
    !eventKey ||
    !blockTime ||
    height <= 0 ||
    sender !== BASE_LAYER_REVENUE_COLLECTOR ||
    recipient !== TC_RESERVE_MODULE ||
    memo !== 'RESERVE' ||
    !amountBase ||
    !coinAmountBase ||
    amountBase !== coinAmountBase
  ) {
    return null;
  }

  const amountRune = baseRuneToNumber(amountBase);
  if (amountRune <= 0) {
    return null;
  }

  const runePriceUsd = Math.max(0, safeNumber(row?.rune_price_usd, 0));
  const amountUsd = Math.max(0, safeNumber(row?.amount_usd, amountRune * runePriceUsd));

  return {
    event_key: eventKey,
    height,
    block_time: blockTime,
    tx_id: String(row?.tx_id || ''),
    sender,
    recipient,
    memo,
    amount_base: amountBase,
    amount_rune: amountRune,
    rune_price_usd: runePriceUsd,
    amount_usd: amountUsd,
    coin,
    source: 'dune',
    raw_event: {
      source: 'dune',
      dune_query_id: config.rujiraReservePaymentsDuneQueryId,
      row
    },
    updated_at: new Date().toISOString()
  };
}

export function buildRujiraReservePaymentRowsFromDune(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeDuneReservePaymentRow)
    .filter((row) => row && row.height > 0 && row.amount_rune > 0);
}

async function runRujiraReservePaymentsDuneIngestion(client) {
  if (!config.duneApiKey || !config.rujiraReservePaymentsDuneQueryId) {
    return {
      skipped: true,
      reason: !config.duneApiKey ? 'missing_dune_api_key' : 'missing_dune_rujira_reserve_payments_query_id',
      source: 'dune',
      rows: 0,
      upserted: 0
    };
  }

  const startTime = toIsoOrNull(config.rujiraReservePaymentsDuneStartTime) || '2026-04-30T00:00:00.000Z';
  const endTime = new Date(Date.now() - Math.max(0, config.rujiraReservePaymentsDuneHeadLagHours) * 60 * 60 * 1000).toISOString();
  const result = await executeDuneQueryRows(config.rujiraReservePaymentsDuneQueryId, {
    start_time: formatDuneDateTime(startTime),
    end_time: formatDuneDateTime(endTime)
  });
  const rows = buildRujiraReservePaymentRowsFromDune(result.rows);

  await upsertRows(client, 'rujira_reserve_payment_events', rows, {
    conflictColumns: ['event_key'],
    jsonColumns: ['raw_event']
  });
  const duplicateRowsDeleted = await pruneDuplicateRujiraReservePaymentEvents(client);

  const heights = rows.map((row) => row.height).filter((height) => height > 0);
  await upsertRows(client, 'rujira_reserve_payment_sync_state', [{
    sync_key: ACTION_SYNC_KEY,
    next_page_token: '',
    next_scheduled_height: heights.length ? Math.max(...heights) : 0,
    complete: true,
    rate_limited_until: null,
    updated_at: new Date().toISOString(),
    stats_json: {
      source: 'dune',
      dune_query_id: config.rujiraReservePaymentsDuneQueryId,
      dune_execution_id: result.executionId,
      start_time: startTime,
      end_time: endTime,
      rows: result.rows.length,
      accepted_rows: rows.length,
      duplicate_rows_deleted: duplicateRowsDeleted
    }
  }], {
    conflictColumns: ['sync_key'],
    jsonColumns: ['stats_json']
  });

  return {
    source: 'dune',
    dune_query_id: config.rujiraReservePaymentsDuneQueryId,
    dune_execution_id: result.executionId,
    start_time: startTime,
    end_time: endTime,
    rows: result.rows.length,
    upserted: rows.length,
    duplicate_rows_deleted: duplicateRowsDeleted,
    min_height: heights.length ? Math.min(...heights) : 0,
    max_height: heights.length ? Math.max(...heights) : 0
  };
}

async function runRujiraReservePaymentsLegacyIngestion(client, initialStats = {}) {
  const stats = {
    ...initialStats,
    midgard_candidates: null,
    scheduled_candidates: null,
    block_scan: null,
    pricing: null,
    provider_cooldown: Boolean(initialStats.provider_cooldown)
  };

  try {
    stats.midgard_candidates = await ingestRujiraReservePaymentMidgardCandidates(client);
  } catch (error) {
    if (!isProviderRateLimit(error)) {
      throw error;
    }
    stats.provider_cooldown = true;
    stats.midgard_candidates = {
      error: error.message,
      rate_limited_until: await putCooldown(client, ACTION_SYNC_KEY, error)
    };
  }

  try {
    stats.scheduled_candidates = await ingestRujiraReservePaymentScheduledCandidates(client);
  } catch (error) {
    if (!isProviderRateLimit(error)) {
      throw error;
    }
    stats.provider_cooldown = true;
    stats.scheduled_candidates = {
      error: error.message,
      rate_limited_until: await putCooldown(client, SCHEDULE_SYNC_KEY, error)
    };
  }

  try {
    stats.block_scan = await processRujiraReservePaymentBlocks(client);
  } catch (error) {
    if (!isProviderRateLimit(error)) {
      throw error;
    }
    stats.provider_cooldown = true;
    stats.block_scan = {
      error: error.message,
      rate_limited_until: await putCooldown(client, ACTION_SYNC_KEY, error)
    };
  }

  stats.pricing = await refreshRujiraReservePaymentPrices(client);

  return stats;
}

export async function runRujiraReservePaymentsIngestion(client) {
  if (config.rujiraReservePaymentsDuneQueryId) {
    try {
      const duneSource = await runRujiraReservePaymentsDuneIngestion(client);
      if (!duneSource?.skipped) {
        return {
          dune_source: duneSource,
          provider_cooldown: false
        };
      }

      return runRujiraReservePaymentsLegacyIngestion(client, {
        dune_source: duneSource,
        fallback_source: 'legacy',
        fallback_reason: duneSource.reason || 'dune_skipped'
      });
    } catch (error) {
      const duneError = summarizeDuneError(error);
      return runRujiraReservePaymentsLegacyIngestion(client, {
        dune_source: {
          source: 'dune',
          status: 'error',
          dune_query_id: config.rujiraReservePaymentsDuneQueryId,
          error: duneError
        },
        fallback_source: 'legacy',
        fallback_reason: 'dune_error'
      });
    }
  }

  return runRujiraReservePaymentsLegacyIngestion(client);
}

export function normalizeRujiraReservePaymentNumber(value) {
  return safeNumber(value);
}
