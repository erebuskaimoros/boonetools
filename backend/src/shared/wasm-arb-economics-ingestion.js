import { createHash } from 'node:crypto';

import { upsertRows } from '../db/sql.js';
import { config } from '../lib/config.js';
import { safeNumber, sleep } from '../lib/utils.js';
import { fetchMidgard, fetchMidgardActions, fetchMidgardSwapHistory } from './midgard.js';
import { fetchThorchainRpc } from './rpc.js';
import { fetchThorchain, extractThorHeight } from './thornode.js';

export const WASM_ARB_CONTRACT =
  'thor1n5a08r0zvmqca39ka2tgwlkjy9ugalutk7fjpzptfppqcccnat2ska5t4g';
export const RUJIRA_TRADE_COLLECTOR =
  'thor1gm8q2gr25nzzsxzdp2mpja4hyvyhjlr4s6krcsgv2y953uu0js3qhwpus7';
export const BASE_LAYER_COLLECTOR =
  'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr';

const FIVE_MINUTES = 300;
const RUNE_BASE = 1e8;
const ACTION_PAGE_LIMIT = 50;
const COLLECTOR_TX_PAGE_LIMIT = 100;
const ACTION_OVERLAP_BLOCKS = 1_200;
const NETWORK_INTERVAL_LIMIT = 400;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function unixSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function parseDateNs(value) {
  try {
    return new Date(Number(BigInt(String(value || '0')) / 1_000_000n));
  } catch {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
}

function floorBucket(seconds) {
  return Math.floor(safeNumber(seconds) / FIVE_MINUTES) * FIVE_MINUTES;
}

function amountE8(value) {
  return safeNumber(value) / RUNE_BASE;
}

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeAsset(value) {
  return String(value || '').trim().toUpperCase().replaceAll('~', '-');
}

function isRuneAsset(value) {
  const asset = normalizeAsset(value);
  return asset === 'THOR.RUNE' || asset === 'RUNE';
}

function actionCoinUsd(transactions, priceUsd) {
  return (transactions || []).reduce(
    (total, tx) => total + (tx?.coins || []).reduce(
      (coinTotal, coin) => coinTotal + amountE8(coin?.amount) * safeNumber(priceUsd),
      0
    ),
    0
  );
}

export function normalizeWasmArbAction(action, arbContract = WASM_ARB_CONTRACT) {
  if (String(action?.type || '').toLowerCase() !== 'swap') return null;
  if (String(action?.status || '').toLowerCase() !== 'success') return null;
  const inbound = Array.isArray(action?.in) ? action.in : [];
  const outbound = Array.isArray(action?.out) ? action.out : [];
  if (!inbound.some((tx) => normalizeAddress(tx?.address) === normalizeAddress(arbContract))) {
    return null;
  }
  const blockTime = parseDateNs(action?.date);
  const height = Math.trunc(safeNumber(action?.height));
  if (!blockTime || !Number.isFinite(blockTime.getTime()) || height <= 0) return null;

  const metadata = action?.metadata?.swap || {};
  const inAsset = inbound.flatMap((tx) => tx?.coins || [])[0]?.asset || '';
  const outAsset = outbound.flatMap((tx) => tx?.coins || []).at(-1)?.asset || '';
  const legCount = !isRuneAsset(inAsset) && !isRuneAsset(outAsset) ? 2 : 1;
  const inputVolumeUsd = actionCoinUsd(inbound, metadata.inPriceUSD);
  const outputVolumeUsd = actionCoinUsd(outbound, metadata.outPriceUSD);
  const txId = String(inbound[0]?.txID || outbound[0]?.txID || '').trim().toUpperCase();
  const identity = [
    height,
    txId,
    action?.date,
    inAsset,
    inbound[0]?.coins?.[0]?.amount,
    outAsset,
    outbound[0]?.coins?.[0]?.amount
  ].join('|');

  return {
    action_key: `wasm-arb-action:v1:${sha256(identity)}`,
    height,
    block_time: blockTime.toISOString(),
    tx_id: txId,
    leg_count: legCount,
    input_volume_usd: inputVolumeUsd,
    executed_leg_volume_usd: inputVolumeUsd + (legCount === 2 ? outputVolumeUsd : 0),
    liquidity_fee_rune: amountE8(metadata.liquidityFee),
    swap_slip_bps: Math.max(0, Math.trunc(safeNumber(metadata.swapSlip))),
    status: String(action?.status || ''),
    raw_action: action,
    observed_at: new Date().toISOString()
  };
}

export function normalizeWasmArbNetworkBucket(interval) {
  const start = Math.trunc(safeNumber(interval?.startTime));
  const end = Math.trunc(safeNumber(interval?.endTime));
  if (start <= 0 || end <= start) return null;
  const runePriceUsd = safeNumber(interval?.runePriceUSD);
  const liquidityFeeRune = amountE8(interval?.totalFees);
  return {
    bucket_start: new Date(start * 1000).toISOString(),
    bucket_end: new Date(end * 1000).toISOString(),
    network_volume_usd: safeNumber(interval?.totalVolumeUSD) / 100,
    network_liquidity_fee_rune: liquidityFeeRune,
    network_liquidity_fee_usd: liquidityFeeRune * runePriceUsd,
    network_swap_leg_count: Math.max(0, Math.trunc(safeNumber(interval?.totalCount))),
    rune_price_usd: runePriceUsd,
    source: 'midgard-swap-history',
    source_json: interval,
    updated_at: new Date().toISOString()
  };
}

function getAttr(event, key) {
  return event?.attributes?.find((attribute) => attribute?.key === key)?.value || '';
}

function attrValues(event, key) {
  return (event?.attributes || [])
    .filter((attribute) => attribute?.key === key)
    .map((attribute) => String(attribute?.value || ''));
}

function transferEntries(event) {
  if (String(event?.type || '') !== 'transfer') return [];
  const senders = attrValues(event, 'sender');
  const recipients = attrValues(event, 'recipient');
  const amounts = attrValues(event, 'amount');
  const count = Math.max(senders.length, recipients.length, amounts.length);
  return Array.from({ length: count }, (_, index) => ({
    sender: normalizeAddress(senders[index]),
    recipient: normalizeAddress(recipients[index]),
    amount: amounts[index] || ''
  }));
}

function parseCoins(value) {
  return String(value || '')
    .split(',')
    .map((coin) => coin.trim())
    .map((coin) => coin.match(/^(\d+)(.+)$/))
    .filter(Boolean)
    .map((match) => ({ amountBase: match[1], denom: match[2].toLowerCase() }));
}

function rangeFeeAmountCounts(events) {
  const counts = new Map();
  for (const event of events || []) {
    if (String(event?.type || '') !== 'wasm-rujira-fin/range.fee') continue;
    const contract = normalizeAddress(getAttr(event, '_contract_address'));
    for (const key of ['base', 'quote']) {
      const amount = String(getAttr(event, key) || '').trim();
      if (!contract || !/^\d+$/.test(amount) || amount === '0') continue;
      const matchKey = `${contract}|${amount}`;
      counts.set(matchKey, (counts.get(matchKey) || 0) + 1);
    }
  }
  return counts;
}

function contractAddresses(events) {
  return new Set(
    (events || [])
      .map((event) => normalizeAddress(getAttr(event, '_contract_address')))
      .filter(Boolean)
  );
}

export function parseWasmArbRujiraFeeEvents({
  height,
  blockTime,
  origin,
  txId = '',
  events = [],
  finContracts = [],
  tradeCollector = RUJIRA_TRADE_COLLECTOR,
  arbContract = WASM_ARB_CONTRACT
}) {
  const finSet = new Set(finContracts.map(normalizeAddress));
  const collector = normalizeAddress(tradeCollector);
  const arb = normalizeAddress(arbContract);
  const contracts = contractAddresses(events);
  const linked = contracts.has(arb);
  const rangeAmounts = rangeFeeAmountCounts(events);
  const parsed = [];
  let ordinal = 0;

  for (const event of events || []) {
    for (const transfer of transferEntries(event)) {
      const { sender, recipient } = transfer;
      if (recipient !== collector || (!finSet.has(sender) && sender !== arb)) continue;

      for (const coin of parseCoins(transfer.amount)) {
        const rangeKey = `${sender}|${coin.amountBase}`;
        const remainingRangeMatches = rangeAmounts.get(rangeKey) || 0;
        const feeKind = sender === arb
          ? 'amm'
          : remainingRangeMatches > 0
            ? 'fin_range'
            : 'fin';
        if (feeKind === 'fin_range') rangeAmounts.set(rangeKey, remainingRangeMatches - 1);
        const eventIdentity = [
          height,
          origin,
          txId,
          ordinal,
          sender,
          recipient,
          coin.amountBase,
          coin.denom
        ].join('|');
        parsed.push({
          event_key: `wasm-arb-rujira-fee:v1:${sha256(eventIdentity)}`,
          height: Math.trunc(safeNumber(height)),
          block_time: new Date(blockTime).toISOString(),
          tx_id: String(txId || '').toUpperCase(),
          event_origin: String(origin || ''),
          event_ordinal: ordinal,
          source_contract: sender,
          fee_kind: feeKind,
          denom: coin.denom,
          amount_base: coin.amountBase,
          amount: safeNumber(coin.amountBase) / RUNE_BASE,
          price_usd: null,
          fee_usd: null,
          price_source: '',
          wasm_linked: sender === arb || linked,
          raw_event: event,
          observed_at: new Date().toISOString()
        });
        ordinal += 1;
      }
    }
  }
  return parsed;
}

function txResponseEvents(response) {
  if (Array.isArray(response?.events)) return response.events;
  if (Array.isArray(response?.tx_result?.events)) return response.tx_result.events;
  return [];
}

export function normalizeCollectorTransferCandidates(
  responses,
  collector = RUJIRA_TRADE_COLLECTOR,
  startHeight = config.wasmArbEconomicsStartHeight
) {
  const target = normalizeAddress(collector);
  return (responses || [])
    .filter((response) => safeNumber(response?.code) === 0)
    .filter((response) => safeNumber(response?.height) >= startHeight)
    .filter((response) => txResponseEvents(response).some((event) => (
      transferEntries(event).some((transfer) => transfer.recipient === target)
    )))
    .map((response) => ({
      height: Math.trunc(safeNumber(response.height)),
      blockTime: Number.isFinite(Date.parse(response.timestamp || ''))
        ? new Date(response.timestamp).toISOString()
        : null,
      source: 'trade-collector-tx'
    }));
}

export function denomToWasmArbPoolAsset(value) {
  let denom = String(value || '').trim().toLowerCase();
  if (denom.startsWith('x/ghost-vault/')) denom = denom.slice('x/ghost-vault/'.length);
  if (denom === 'rune') return 'THOR.RUNE';
  if (denom.startsWith('x/')) return `THOR.${denom.slice(2).toUpperCase()}`;
  if (denom.startsWith('thor.')) return denom.toUpperCase();
  if (!denom.includes('-')) return `THOR.${denom.toUpperCase()}`;
  const splitAt = denom.indexOf('-');
  return `${denom.slice(0, splitAt).toUpperCase()}.${denom.slice(splitAt + 1).toUpperCase()}`;
}

function isStableDenom(denom) {
  return /(?:usdc|usdt|dai|gusd|usdp)/i.test(String(denom || ''));
}

async function getSyncState(client, syncKey) {
  const { rows } = await client.query(
    `select sync_key, cursor_value, next_page_token, complete, stats_json, updated_at
     from wasm_arb_economics_sync_state
     where sync_key = $1`,
    [syncKey]
  );
  return rows[0] || {
    sync_key: syncKey,
    cursor_value: '',
    next_page_token: '',
    complete: false,
    stats_json: {}
  };
}

async function setSyncState(client, syncKey, values = {}) {
  await client.query(
    `insert into wasm_arb_economics_sync_state (
       sync_key, cursor_value, next_page_token, complete, stats_json, updated_at
     ) values ($1, $2, $3, $4, $5, now())
     on conflict (sync_key)
     do update set
       cursor_value = excluded.cursor_value,
       next_page_token = excluded.next_page_token,
       complete = excluded.complete,
       stats_json = excluded.stats_json,
       updated_at = now()`,
    [
      syncKey,
      String(values.cursorValue || ''),
      String(values.nextPageToken || ''),
      Boolean(values.complete),
      values.stats || {}
    ]
  );
}

async function enqueueBlocks(client, candidates) {
  const grouped = new Map();
  for (const candidate of candidates || []) {
    const height = Math.trunc(safeNumber(candidate?.height));
    if (height <= 0) continue;
    const existing = grouped.get(height) || {
      height,
      block_time: candidate.blockTime || null,
      source_addresses: []
    };
    if (!existing.block_time && candidate.blockTime) existing.block_time = candidate.blockTime;
    if (candidate.source && !existing.source_addresses.includes(candidate.source)) {
      existing.source_addresses.push(candidate.source);
    }
    grouped.set(height, existing);
  }
  await upsertRows(client, 'wasm_arb_economics_blocks', [...grouped.values()], {
    columns: ['height', 'block_time', 'source_addresses'],
    conflictColumns: ['height'],
    updateColumns: ['block_time', 'source_addresses'],
    jsonColumns: ['source_addresses']
  });
  return grouped.size;
}

function actionCandidate(action, source) {
  const date = parseDateNs(action?.date);
  return {
    height: Math.trunc(safeNumber(action?.height)),
    blockTime: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
    source
  };
}

async function persistArbActions(client, actions) {
  const rows = actions.map((action) => normalizeWasmArbAction(action)).filter(Boolean);
  await upsertRows(client, 'wasm_arb_economics_actions', rows, {
    conflictColumns: ['action_key'],
    jsonColumns: ['raw_action']
  });
  return rows;
}

async function scanActionPages(client, options) {
  const {
    address,
    source,
    syncKey,
    maxPages,
    backfill,
    fetchActions = fetchMidgardActions
  } = options;
  const state = await getSyncState(client, syncKey);
  if (backfill && state.complete) return { pages: 0, actions: 0, blocks: 0, complete: true };

  const startSeconds = unixSeconds(config.wasmArbEconomicsStartTime);
  const previousMaxHeight = safeNumber(state.stats_json?.max_height);
  const stopHeight = backfill ? 0 : Math.max(0, previousMaxHeight - ACTION_OVERLAP_BLOCKS);
  let token = backfill ? String(state.next_page_token || '') : '';
  let pages = 0;
  let actionCount = 0;
  let maxHeight = previousMaxHeight;
  let complete = Boolean(state.complete);
  const candidates = [];

  while (pages < Math.max(1, maxPages)) {
    const payload = await fetchActions({
      address,
      limit: ACTION_PAGE_LIMIT,
      ...(token ? { nextPageToken: token } : {})
    });
    const pageActions = Array.isArray(payload?.actions) ? payload.actions : [];
    if (!pageActions.length) {
      if (backfill) complete = true;
      break;
    }
    pages += 1;
    const retained = pageActions.filter((action) => {
      const date = parseDateNs(action?.date);
      return date && Math.floor(date.getTime() / 1000) >= startSeconds;
    });
    actionCount += retained.length;
    maxHeight = Math.max(maxHeight, ...retained.map((action) => safeNumber(action?.height)), 0);
    candidates.push(...retained.map((action) => actionCandidate(action, source)));
    if (source === 'wasm-arb') await persistArbActions(client, retained);

    const oldest = pageActions.reduce((value, action) => {
      const date = parseDateNs(action?.date);
      const seconds = date ? Math.floor(date.getTime() / 1000) : Infinity;
      return Math.min(value, seconds);
    }, Infinity);
    const oldestHeight = pageActions.reduce(
      (value, action) => Math.min(value, safeNumber(action?.height, Infinity)),
      Infinity
    );
    token = String(payload?.meta?.nextPageToken || '');
    if (oldest <= startSeconds || !token) {
      if (backfill) complete = true;
      break;
    }
    if (!backfill && stopHeight > 0 && oldestHeight <= stopHeight) break;
    if (config.wasmArbEconomicsRequestDelayMs > 0) {
      await sleep(config.wasmArbEconomicsRequestDelayMs);
    }
  }

  const blocks = await enqueueBlocks(client, candidates);
  await setSyncState(client, syncKey, {
    cursorValue: String(maxHeight || ''),
    nextPageToken: backfill && !complete ? token : '',
    complete: backfill ? complete : Boolean(state.complete),
    stats: {
      ...(state.stats_json || {}),
      max_height: maxHeight,
      last_pages: pages,
      last_actions: actionCount,
      last_scanned_at: new Date().toISOString()
    }
  });
  return { pages, actions: actionCount, blocks, complete };
}

async function ingestActions(client, options = {}) {
  const streams = [
    { key: 'arb', address: WASM_ARB_CONTRACT, source: 'wasm-arb' }
  ];
  const results = {};
  for (const stream of streams) {
    results[`${stream.key}_head`] = await scanActionPages(client, {
      ...stream,
      syncKey: `actions:${stream.key}`,
      maxPages: config.wasmArbEconomicsActionHeadPages,
      backfill: false,
      fetchActions: options.fetchActions
    });
    results[`${stream.key}_backfill`] = await scanActionPages(client, {
      ...stream,
      syncKey: `actions-backfill:${stream.key}`,
      maxPages: config.wasmArbEconomicsActionBackfillPages,
      backfill: true,
      fetchActions: options.fetchActions
    });
  }
  return results;
}

async function fetchCollectorTransferPage(client, params, options = {}) {
  if (typeof options.fetchCollectorTransferPage === 'function') {
    return options.fetchCollectorTransferPage(params);
  }
  const query = new URLSearchParams({
    query: `tx.height>=${config.wasmArbEconomicsStartHeight} AND transfer.recipient='${RUJIRA_TRADE_COLLECTOR}'`,
    'pagination.limit': String(COLLECTOR_TX_PAGE_LIMIT),
    'pagination.offset': String(params.offset),
    'pagination.count_total': 'true',
    order_by: params.orderBy
  });
  return fetchThorchain(`/cosmos/tx/v1beta1/txs?${query}`, {
    historical: params.backfill,
    timeoutMs: 30_000,
    cooldownClient: client,
    sharedCooldown: true
  });
}

async function scanCollectorTransferPages(client, options = {}) {
  const { syncKey, maxPages, backfill } = options;
  const state = await getSyncState(client, syncKey);
  if (backfill && state.complete) return { pages: 0, transactions: 0, blocks: 0, complete: true };

  const previousMaxHeight = safeNumber(state.stats_json?.max_height);
  const stopHeight = Math.max(0, previousMaxHeight - ACTION_OVERLAP_BLOCKS);
  let offset = backfill ? Math.max(0, Math.trunc(safeNumber(state.cursor_value))) : 0;
  let pages = 0;
  let transactionCount = 0;
  let blockCount = 0;
  let maxHeight = previousMaxHeight;
  let complete = Boolean(state.complete);

  while (pages < Math.max(1, maxPages)) {
    const payload = await fetchCollectorTransferPage(client, {
      offset,
      backfill,
      orderBy: backfill ? 'ORDER_BY_ASC' : 'ORDER_BY_DESC'
    }, options);
    const responses = Array.isArray(payload?.tx_responses) ? payload.tx_responses : [];
    const total = Math.max(0, Math.trunc(safeNumber(payload?.total)));
    if (!responses.length) {
      if (backfill) complete = true;
      break;
    }

    pages += 1;
    transactionCount += responses.length;
    const candidates = normalizeCollectorTransferCandidates(responses);
    blockCount += await enqueueBlocks(client, candidates);
    const heights = responses.map((response) => safeNumber(response?.height)).filter((height) => height > 0);
    maxHeight = Math.max(maxHeight, ...heights, 0);
    offset += responses.length;

    if (responses.length < COLLECTOR_TX_PAGE_LIMIT || (total > 0 && offset >= total)) {
      if (backfill) complete = true;
      break;
    }
    if (!backfill && stopHeight > 0 && Math.min(...heights, Infinity) <= stopHeight) break;
    if (config.wasmArbEconomicsRequestDelayMs > 0) {
      await sleep(config.wasmArbEconomicsRequestDelayMs);
    }
  }

  await setSyncState(client, syncKey, {
    cursorValue: String(backfill ? offset : maxHeight),
    complete: backfill ? complete : Boolean(state.complete),
    stats: {
      ...(state.stats_json || {}),
      max_height: maxHeight,
      last_pages: pages,
      last_transactions: transactionCount,
      last_blocks: blockCount,
      last_scanned_at: new Date().toISOString()
    }
  });
  return { pages, transactions: transactionCount, blocks: blockCount, complete };
}

async function ingestCollectorTransfers(client, options = {}) {
  return {
    head: await scanCollectorTransferPages(client, {
      ...options,
      syncKey: 'collector-transfers',
      maxPages: config.wasmArbEconomicsTransferHeadPages,
      backfill: false
    }),
    backfill: await scanCollectorTransferPages(client, {
      ...options,
      syncKey: 'collector-transfers-backfill',
      maxPages: config.wasmArbEconomicsTransferBackfillPages,
      backfill: true
    })
  };
}

async function ingestNetworkBuckets(client, options = {}) {
  const state = await getSyncState(client, 'network:5min');
  const startSeconds = floorBucket(unixSeconds(config.wasmArbEconomicsStartTime));
  const targetEnd = floorBucket(Date.now() / 1000);
  let cursor = Math.max(startSeconds, Math.trunc(safeNumber(state.cursor_value, startSeconds)));
  let chunks = 0;
  let rowCount = 0;

  while (cursor < targetEnd && chunks < config.wasmArbEconomicsNetworkChunks) {
    const until = Math.min(targetEnd, cursor + NETWORK_INTERVAL_LIMIT * FIVE_MINUTES);
    const payload = await (options.fetchSwapHistory || fetchMidgardSwapHistory)({
      interval: '5min',
      from: cursor,
      to: until
    });
    const rows = (payload?.intervals || [])
      .map(normalizeWasmArbNetworkBucket)
      .filter((row) => unixSeconds(row.bucket_end) <= targetEnd);
    if (!rows.length) break;
    await upsertRows(client, 'wasm_arb_economics_network_buckets', rows, {
      conflictColumns: ['bucket_start'],
      jsonColumns: ['source_json']
    });
    rowCount += rows.length;
    chunks += 1;
    const nextCursor = Math.max(...rows.map((row) => unixSeconds(row.bucket_end)));
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
    if (config.wasmArbEconomicsRequestDelayMs > 0) {
      await sleep(config.wasmArbEconomicsRequestDelayMs);
    }
  }

  await setSyncState(client, 'network:5min', {
    cursorValue: String(cursor),
    complete: cursor >= targetEnd,
    stats: {
      rows: rowCount,
      chunks,
      target_end: targetEnd,
      last_scanned_at: new Date().toISOString()
    }
  });
  return { rows: rowCount, chunks, cursor, targetEnd, complete: cursor >= targetEnd };
}

async function fetchFinContracts(options = {}) {
  const fetchThor = options.fetchThorchain || fetchThorchain;
  const contracts = [];
  for (const rawCodeId of config.wasmArbEconomicsFinCodeIds) {
    const codeId = String(rawCodeId || '').trim();
    if (!/^\d+$/.test(codeId)) continue;
    const payload = await fetchThor(
      `/cosmwasm/wasm/v1/code/${codeId}/contracts?pagination.limit=200`
    );
    contracts.push(...(Array.isArray(payload?.contracts) ? payload.contracts : []));
  }
  return [...new Set(contracts.map(normalizeAddress).filter(Boolean))];
}

function blockContexts(payload) {
  const result = payload?.result || payload || {};
  const contexts = (result.txs_results || []).map((tx, index) => ({
    origin: `tx_${index}`,
    txId: '',
    events: Array.isArray(tx?.events) ? tx.events : []
  }));
  const finalizeEvents = result.finalize_block_events || result.end_block_events || [];
  if (Array.isArray(finalizeEvents) && finalizeEvents.length) {
    contexts.push({ origin: 'finalize_block', txId: '', events: finalizeEvents });
  }
  return contexts;
}

async function scanCandidateBlocks(client, options = {}) {
  const finContracts = await fetchFinContracts(options);
  const { rows: blocks } = await client.query(
    `select height, block_time, attempts
     from wasm_arb_economics_blocks
     where status in ('pending', 'error') and next_retry_at <= now()
     order by height asc
     limit $1`,
    [Math.max(1, config.wasmArbEconomicsBlockMaxHeights)]
  );
  let eventCount = 0;
  let failures = 0;

  for (const block of blocks) {
    try {
      const payload = await (options.fetchRpc || fetchThorchainRpc)(
        '/block_results',
        { height: block.height },
        { cooldownClient: client, sharedCooldown: true }
      );
      const blockTime = block.block_time || new Date().toISOString();
      const events = blockContexts(payload).flatMap((context) => (
        parseWasmArbRujiraFeeEvents({
          height: block.height,
          blockTime,
          origin: context.origin,
          txId: context.txId,
          events: context.events,
          finContracts
        })
      ));
      await upsertRows(client, 'wasm_arb_economics_rujira_fees', events, {
        conflictColumns: ['event_key'],
        jsonColumns: ['raw_event']
      });
      eventCount += events.length;
      await client.query(
        `update wasm_arb_economics_blocks
         set status = 'fetched', attempts = attempts + 1, error = '',
             event_count = $2, fetched_at = now(), updated_at = now()
         where height = $1`,
        [block.height, events.length]
      );
    } catch (error) {
      failures += 1;
      const attempts = Math.max(1, safeNumber(block.attempts) + 1);
      const retrySeconds = Math.min(3600, 30 * 2 ** Math.min(7, attempts - 1));
      await client.query(
        `update wasm_arb_economics_blocks
         set status = 'error', attempts = attempts + 1, error = $2,
             next_retry_at = now() + ($3::text || ' seconds')::interval,
             updated_at = now()
         where height = $1`,
        [block.height, String(error?.message || error).slice(0, 500), retrySeconds]
      );
    }
    if (config.wasmArbEconomicsRequestDelayMs > 0) {
      await sleep(config.wasmArbEconomicsRequestDelayMs);
    }
  }
  return { blocks: blocks.length, events: eventCount, failures, finContracts: finContracts.length };
}

async function fetchPriceIntervals(poolAsset, from, to, options = {}) {
  const prices = new Map();
  let cursor = floorBucket(from);
  const target = floorBucket(to) + FIVE_MINUTES;
  while (cursor < target) {
    const until = Math.min(target, cursor + NETWORK_INTERVAL_LIMIT * FIVE_MINUTES);
    const query = new URLSearchParams({
      interval: '5min',
      from: String(cursor),
      to: String(until)
    });
    const payload = await (options.fetchMidgard || fetchMidgard)(
      `/history/depths/${encodeURIComponent(poolAsset)}?${query}`,
      { cooldownClient: options.client, sharedCooldown: true }
    );
    for (const interval of payload?.intervals || []) {
      const price = safeNumber(interval?.assetPriceUSD);
      if (price > 0) prices.set(floorBucket(interval?.startTime), price);
    }
    cursor = until;
    if (config.wasmArbEconomicsRequestDelayMs > 0) {
      await sleep(config.wasmArbEconomicsRequestDelayMs);
    }
  }
  return prices;
}

async function priceRujiraFeeEvents(client, options = {}) {
  const { rows } = await client.query(
    `select event_key, height, block_time, tx_id, event_origin, event_ordinal,
            source_contract, fee_kind, denom, amount_base, amount,
            price_usd, fee_usd, price_source, wasm_linked, raw_event, observed_at
     from wasm_arb_economics_rujira_fees
     where fee_usd is null
     order by block_time asc
     limit 5000`
  );
  if (!rows.length) return { priced: 0, unpriced: 0, errors: [] };

  const { rows: networkRows } = await client.query(
    `select bucket_start, rune_price_usd
     from wasm_arb_economics_network_buckets
     where bucket_start >= $1::timestamptz - interval '5 minutes'
       and bucket_start <= $2::timestamptz + interval '5 minutes'`,
    [rows[0].block_time, rows.at(-1).block_time]
  );
  const runePrices = new Map(networkRows.map((row) => [
    floorBucket(unixSeconds(row.bucket_start)),
    safeNumber(row.rune_price_usd)
  ]));
  const priceMaps = new Map();
  const errors = [];
  const denoms = [...new Set(rows.map((row) => String(row.denom || '').toLowerCase()))];
  for (const denom of denoms) {
    if (denom === 'rune' || isStableDenom(denom)) continue;
    try {
      priceMaps.set(denom, await fetchPriceIntervals(
        denomToWasmArbPoolAsset(denom),
        unixSeconds(rows[0].block_time),
        unixSeconds(rows.at(-1).block_time),
        { ...options, client }
      ));
    } catch (error) {
      errors.push(`${denom}: ${error?.message || error}`);
    }
  }

  const pricedRows = [];
  for (const row of rows) {
    const denom = String(row.denom || '').toLowerCase();
    const bucket = floorBucket(unixSeconds(row.block_time));
    const price = denom === 'rune'
      ? runePrices.get(bucket) || 0
      : isStableDenom(denom)
        ? 1
        : priceMaps.get(denom)?.get(bucket) || 0;
    if (!(price > 0)) continue;
    pricedRows.push({
      ...row,
      price_usd: price,
      fee_usd: safeNumber(row.amount) * price,
      price_source: isStableDenom(denom)
        ? 'stable-parity'
        : denom === 'rune'
          ? 'midgard-rune-5min'
          : 'midgard-depth-5min',
      raw_event: row.raw_event || {}
    });
  }
  await upsertRows(client, 'wasm_arb_economics_rujira_fees', pricedRows, {
    conflictColumns: ['event_key'],
    jsonColumns: ['raw_event']
  });
  return { priced: pricedRows.length, unpriced: rows.length - pricedRows.length, errors };
}

function findMimirValue(payload) {
  for (const [key, value] of Object.entries(payload || {})) {
    if (key.replaceAll('_', '').toLowerCase() === 'wasmarbslipminbps') {
      return Math.trunc(safeNumber(value));
    }
  }
  return null;
}

async function currentTcShare(client) {
  const { rows } = await client.query(
    `select payload_json
     from api_read_models
     where model_key = 'app-layer-live-state:v3'
     limit 1`
  );
  const targets = rows[0]?.payload_json?.configs?.trade?.target_addresses || [];
  const total = targets.reduce((sum, row) => sum + safeNumber(row?.[1]), 0);
  const base = targets.reduce(
    (sum, row) => normalizeAddress(row?.[0]) === BASE_LAYER_COLLECTOR
      ? sum + safeNumber(row?.[1])
      : sum,
    0
  );
  return total > 0 ? base / total : null;
}

async function observeRegime(client, options = {}) {
  const fetchThor = options.fetchThorchain || fetchThorchain;
  const [mimir, lastblock] = await Promise.all([
    fetchThor('/thorchain/mimir'),
    fetchThor('/thorchain/lastblock')
  ]);
  const value = findMimirValue(mimir);
  if (value === null) throw new Error('WasmArbSlipMinBps is missing from THORNode Mimir');
  const height = Math.trunc(extractThorHeight(lastblock));
  const share = await currentTcShare(client);
  const { rows } = await client.query(
    `select activation_height, mimir_value, tc_share
     from wasm_arb_economics_regimes
     order by activation_height desc
     limit 1`
  );
  const previous = rows[0] || null;
  const tcShare = share ?? safeNumber(previous?.tc_share, 0.5);
  const mimirChanged = !previous || value !== safeNumber(previous.mimir_value);
  const shareChanged = !previous
    || Math.abs(tcShare - safeNumber(previous.tc_share, 0.5)) > 1e-9;
  const changed = mimirChanged || shareChanged;
  if (!changed) return { changed: false, height, mimirValue: value, tcShare };

  await client.query(
    `insert into wasm_arb_economics_regimes (
       activation_height, activation_time, mimir_value, previous_mimir_value,
       arb_contract, trade_collector, base_layer_collector, tc_share,
       source, observed_at, metadata_json
     ) values ($1, now(), $2, $3, $4, $5, $6, $7, 'scheduled-observation', now(), $8)
     on conflict (activation_height) do update set
       mimir_value = excluded.mimir_value,
       previous_mimir_value = excluded.previous_mimir_value,
       tc_share = excluded.tc_share,
       observed_at = excluded.observed_at,
       metadata_json = excluded.metadata_json`,
    [
      height,
      value,
      previous ? safeNumber(previous.mimir_value) : null,
      WASM_ARB_CONTRACT,
      RUJIRA_TRADE_COLLECTOR,
      BASE_LAYER_COLLECTOR,
      tcShare,
      {
        change_kind: mimirChanged ? 'mimir' : 'tc-share',
        precision: 'observed within scheduler interval'
      }
    ]
  );
  return { changed: true, height, mimirValue: value, tcShare };
}

async function pruneOldRows(client) {
  const days = Math.max(30, Math.trunc(config.wasmArbEconomicsRetentionDays));
  const tables = [
    ['wasm_arb_economics_network_buckets', 'bucket_start'],
    ['wasm_arb_economics_actions', 'block_time'],
    ['wasm_arb_economics_rujira_fees', 'block_time'],
    ['wasm_arb_economics_blocks', 'block_time']
  ];
  const deleted = {};
  for (const [table, column] of tables) {
    const result = await client.query(
      `delete from ${table}
       where ${column} is not null
         and ${column} < now() - ($1::text || ' days')::interval`,
      [days]
    );
    deleted[table] = result.rowCount || 0;
  }
  return deleted;
}

export async function runWasmArbEconomicsIngestion(client, options = {}) {
  const stats = {};
  stats.network = await ingestNetworkBuckets(client, options);
  stats.actions = await ingestActions(client, options);
  stats.collectorTransfers = await ingestCollectorTransfers(client, options);
  stats.blocks = await scanCandidateBlocks(client, options);
  stats.pricing = await priceRujiraFeeEvents(client, options);
  try {
    stats.regime = await observeRegime(client, options);
  } catch (error) {
    stats.regime = { changed: false, error: error?.message || String(error) };
  }
  stats.pruned = await pruneOldRows(client);
  return stats;
}
