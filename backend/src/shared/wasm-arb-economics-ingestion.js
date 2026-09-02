import { createHash } from 'node:crypto';

import { upsertRows } from '../db/sql.js';
import { config } from '../lib/config.js';
import { safeNumber, sleep } from '../lib/utils.js';
import { fetchMidgard, fetchMidgardActions, fetchMidgardSwapHistory } from './midgard.js';
import { fetchThorchainRpc } from './rpc.js';
import {
  ensureThorchainMarketSnapshot,
  pruneThorchainMarketSnapshots
} from './thorchain-market-snapshots.js';
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
const COLLECTOR_HEAD_WINDOW_BLOCKS = 10_000;
const ACTION_OVERLAP_BLOCKS = 1_200;
const FEE_DISCOVERY_COOLDOWN_SCOPE = 'wasm-fee-discovery';
const FEE_BLOCK_COOLDOWN_SCOPE = 'wasm-fee-blocks';
const NETWORK_INTERVAL_LIMIT = 400;
const WASM_THORNODE_REQUEST_TIMEOUT_MS = 15_000;
const WASM_ARB_ACCOUNTING_VERSION = 2;
const ORACLE_EMPTY_PRICES_CODE = 'WASM_ORACLE_EMPTY_PRICES';
const MISSING_POOL_CACHE_PREFIX = 'wasm-arb:missing-price-pool:';
const TRACKED_ORACLE_POOLS = new Map([
  ['AVAX.AVAX', 'AVAX'],
  ['AVAX.USDC', 'USDC'],
  ['BCH.BCH', 'BCH'],
  ['BTC.BTC', 'BTC'],
  ['DOGE.DOGE', 'DOGE'],
  ['ETH.ETH', 'ETH'],
  ['ETH.USDC', 'USDC'],
  ['ETH.USDT', 'USDT'],
  ['ETH.WBTC', 'BTC'],
  ['GAIA.ATOM', 'ATOM'],
  ['LTC.LTC', 'LTC'],
  ['XRP.XRP', 'XRP']
]);

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

function transactionIdentity(transaction) {
  return JSON.stringify({
    txId: String(transaction?.txID || '').trim().toUpperCase(),
    address: normalizeAddress(transaction?.address),
    memo: String(transaction?.memo || ''),
    coins: (transaction?.coins || []).map((coin) => ({
      asset: normalizeAsset(coin?.asset),
      amount: String(coin?.amount || '')
    }))
  });
}

export function dedupeWasmArbOutboundTransactions(transactions = []) {
  const seen = new Set();
  return (transactions || []).filter((transaction) => {
    const identity = transactionIdentity(transaction);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function normalizeWasmArbAction(action, arbContract = WASM_ARB_CONTRACT) {
  if (String(action?.type || '').toLowerCase() !== 'swap') return null;
  if (String(action?.status || '').toLowerCase() !== 'success') return null;
  const inbound = Array.isArray(action?.in) ? action.in : [];
  const outbound = dedupeWasmArbOutboundTransactions(
    Array.isArray(action?.out) ? action.out : []
  );
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
    action_key: `wasm-arb-action:v${WASM_ARB_ACCOUNTING_VERSION}:${sha256(identity)}`,
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

function poolComparisonKey(asset) {
  const normalized = normalizeAsset(asset);
  const splitAt = normalized.indexOf('.');
  if (splitAt < 1) return normalized;
  const chain = normalized.slice(0, splitAt);
  const ticker = normalized.slice(splitAt + 1).split('-')[0];
  return `${chain}.${ticker}`;
}

export function buildWasmArbOracleTrackingRows({
  height,
  blockTime,
  pools = [],
  oraclePrices = []
}) {
  const timestamp = new Date(blockTime);
  if (!Number.isFinite(timestamp.getTime())) return [];
  const prices = new Map((oraclePrices?.prices || oraclePrices || []).map((row) => [
    String(row?.symbol || '').toUpperCase(),
    safeNumber(row?.price ?? row?.amount)
  ]));
  const runeOraclePriceUsd = prices.get('RUNE') || 0;
  if (!(runeOraclePriceUsd > 0)) return [];

  return (pools || []).flatMap((pool) => {
    const poolAsset = normalizeAsset(pool?.asset);
    const oracleSymbol = TRACKED_ORACLE_POOLS.get(poolComparisonKey(poolAsset));
    if (!oracleSymbol || String(pool?.status || '') !== 'Available') return [];
    const oraclePriceUsd = prices.get(oracleSymbol) || 0;
    const runeDepth = amountE8(pool?.balance_rune);
    const assetDepth = amountE8(pool?.balance_asset);
    if (!(oraclePriceUsd > 0) || !(runeDepth > 0) || !(assetDepth > 0)) return [];
    const poolPriceUsd = (runeDepth / assetDepth) * runeOraclePriceUsd;
    const signedDeviationBps = (poolPriceUsd / oraclePriceUsd - 1) * 10_000;
    return [{
      height: Math.trunc(safeNumber(height)),
      block_time: timestamp.toISOString(),
      pool_asset: poolAsset,
      oracle_symbol: oracleSymbol,
      pool_price_usd: poolPriceUsd,
      oracle_price_usd: oraclePriceUsd,
      signed_deviation_bps: signedDeviationBps,
      absolute_deviation_bps: Math.abs(signedDeviationBps),
      rune_depth_usd: runeDepth * runeOraclePriceUsd,
      source_json: {
        balanceRune: String(pool?.balance_rune || ''),
        balanceAsset: String(pool?.balance_asset || ''),
        runeOraclePriceUsd,
        oraclePriceUsd
      },
      observed_at: new Date().toISOString()
    }];
  });
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

function normalizeFinContracts(finContracts = []) {
  return new Map(finContracts.map((contract) => {
    if (typeof contract === 'string') {
      return [normalizeAddress(contract), { address: normalizeAddress(contract), denoms: [] }];
    }
    const address = normalizeAddress(contract?.address || contract?.contract);
    return [address, {
      address,
      denoms: (contract?.denoms || []).map((denom) => String(denom || '').toLowerCase())
    }];
  }).filter(([address]) => Boolean(address)));
}

function finExecutionPriceHints(events, finContracts) {
  const totals = new Map();
  for (const event of events || []) {
    if (String(event?.type || '') !== 'wasm-rujira-fin/trade') continue;
    const address = normalizeAddress(getAttr(event, '_contract_address'));
    const contract = finContracts.get(address);
    if (!contract || contract.denoms.length < 2) continue;
    const side = String(getAttr(event, 'side') || '').toLowerCase();
    const offer = safeNumber(getAttr(event, 'offer'));
    const bid = safeNumber(getAttr(event, 'bid'));
    if (!(offer > 0) || !(bid > 0) || !['base', 'quote'].includes(side)) continue;
    const current = totals.get(address) || { baseAmount: 0, quoteAmount: 0 };
    if (side === 'base') {
      current.baseAmount += bid;
      current.quoteAmount += offer;
    } else {
      current.baseAmount += offer;
      current.quoteAmount += bid;
    }
    totals.set(address, current);
  }

  return new Map([...totals.entries()].map(([address, amounts]) => {
    const contract = finContracts.get(address);
    return [address, {
      baseDenom: contract.denoms[0],
      quoteDenom: contract.denoms[1],
      quotePerBase: amounts.baseAmount > 0 ? amounts.quoteAmount / amounts.baseAmount : 0
    }];
  }).filter(([, hint]) => hint.quotePerBase > 0));
}

export function deriveFinExecutionPriceUsd({
  denom,
  hint,
  basePriceUsd = 0,
  quotePriceUsd = 0
}) {
  const target = String(denom || '').toLowerCase();
  const baseDenom = String(hint?.baseDenom || '').toLowerCase();
  const quoteDenom = String(hint?.quoteDenom || '').toLowerCase();
  const quotePerBase = safeNumber(hint?.quotePerBase);
  if (!(quotePerBase > 0)) return null;
  if (target === baseDenom && quotePriceUsd > 0) {
    return { priceUsd: quotePerBase * quotePriceUsd, counterDenom: quoteDenom };
  }
  if (target === quoteDenom && basePriceUsd > 0) {
    return { priceUsd: basePriceUsd / quotePerBase, counterDenom: baseDenom };
  }
  return null;
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
  const finMap = normalizeFinContracts(finContracts);
  const finSet = new Set(finMap.keys());
  const collector = normalizeAddress(tradeCollector);
  const arb = normalizeAddress(arbContract);
  const contracts = contractAddresses(events);
  const transactionLinked = String(origin || '').startsWith('tx_') && contracts.has(arb);
  const rangeAmounts = rangeFeeAmountCounts(events);
  const executionPriceHints = String(origin || '').startsWith('tx_')
    ? finExecutionPriceHints(events, finMap)
    : new Map();
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
          event_key: `wasm-arb-rujira-fee:v${WASM_ARB_ACCOUNTING_VERSION}:${sha256(eventIdentity)}`,
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
          wasm_linked: sender === arb || transactionLinked,
          raw_event: {
            transferEvent: event,
            finExecutionPrice: executionPriceHints.get(sender) || null
          },
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
    if (height < config.wasmArbEconomicsStartHeight) continue;
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
  const rows = [...grouped.values()];
  if (rows.length) {
    await client.query(
      `insert into wasm_arb_economics_blocks as existing (
         height, block_time, source_addresses, scan_version
       )
       select candidate.height, candidate.block_time, candidate.source_addresses, $2::integer
       from jsonb_to_recordset($1::jsonb) as candidate(
         height bigint,
         block_time timestamptz,
         source_addresses jsonb
       )
       on conflict (height) do update set
         block_time = coalesce(existing.block_time, excluded.block_time),
         status = case
           when existing.scan_version < excluded.scan_version then 'pending'
           else existing.status
         end,
         attempts = case
           when existing.scan_version < excluded.scan_version then 0
           else existing.attempts
         end,
         next_retry_at = case
           when existing.scan_version < excluded.scan_version then now()
           else existing.next_retry_at
         end,
         error = case
           when existing.scan_version < excluded.scan_version then ''
           else existing.error
         end,
         event_count = case
           when existing.scan_version < excluded.scan_version then 0
           else existing.event_count
         end,
         fetched_at = case
           when existing.scan_version < excluded.scan_version then null
           else existing.fetched_at
         end,
         scan_version = greatest(existing.scan_version, excluded.scan_version),
         source_addresses = (
           select coalesce(jsonb_agg(source), '[]'::jsonb)
           from (
             select distinct source
             from jsonb_array_elements(
               existing.source_addresses || excluded.source_addresses
             ) as merged(source)
           ) unique_sources
         ),
         updated_at = now()`,
      [JSON.stringify(rows), WASM_ARB_ACCOUNTING_VERSION]
    );
  }
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
      syncKey: `actions:${stream.key}:v${WASM_ARB_ACCOUNTING_VERSION}`,
      maxPages: config.wasmArbEconomicsActionHeadPages,
      backfill: false,
      fetchActions: options.fetchActions
    });
    results[`${stream.key}_backfill`] = await scanActionPages(client, {
      ...stream,
      syncKey: `actions-backfill:${stream.key}:v${WASM_ARB_ACCOUNTING_VERSION}`,
      maxPages: config.wasmArbEconomicsActionBackfillPages,
      backfill: true,
      fetchActions: options.fetchActions
    });
  }
  return results;
}

export function normalizeCollectorTxSearchCandidates(
  txs,
  startHeight = config.wasmArbEconomicsStartHeight
) {
  return (txs || [])
    .filter((tx) => safeNumber(tx?.tx_result?.code) === 0)
    .filter((tx) => safeNumber(tx?.height) >= startHeight)
    .map((tx) => ({
      height: Math.trunc(safeNumber(tx.height)),
      blockTime: null,
      source: 'trade-collector-tx-search'
    }));
}

export function normalizeCollectorBlockSearchCandidates(
  blocks,
  startHeight = config.wasmArbEconomicsStartHeight
) {
  return (blocks || [])
    .map((row) => row?.block || row)
    .filter((block) => safeNumber(block?.header?.height) >= startHeight)
    .map((block) => ({
      height: Math.trunc(safeNumber(block.header.height)),
      blockTime: Number.isFinite(Date.parse(block.header.time || ''))
        ? new Date(block.header.time).toISOString()
        : null,
      source: 'trade-collector-block-search'
    }));
}

async function fetchCollectorSearchPage(client, params, options = {}) {
  const injected = params.kind === 'tx'
    ? options.fetchCollectorTxSearchPage || options.fetchCollectorTransferPage
    : options.fetchCollectorBlockSearchPage;
  if (typeof injected === 'function') return injected(params);

  const heightKey = params.kind === 'tx' ? 'tx.height' : 'block.height';
  const queryText = [
    `${heightKey}>=${params.startHeight}`,
    `${heightKey}<=${params.endHeight}`,
    `transfer.recipient='${RUJIRA_TRADE_COLLECTOR}'`
  ].join(' AND ');
  const fetchRpc = options.fetchRpc || fetchThorchainRpc;
  const payload = await fetchRpc(`/${params.kind}_search`, {
    query: JSON.stringify(queryText),
    page: params.page,
    per_page: COLLECTOR_TX_PAGE_LIMIT,
    order_by: JSON.stringify(params.orderBy)
  }, {
    timeoutMs: 30_000,
    cooldownClient: client,
    sharedCooldown: true,
    cooldownScope: FEE_DISCOVERY_COOLDOWN_SCOPE
  });
  if (payload?.error) {
    throw new Error(payload.error?.data || payload.error?.message || `${params.kind}_search failed`);
  }
  return payload?.result || {};
}

export async function scanCollectorSearchPages(client, options = {}) {
  const { syncKey, maxPages, backfill, kind, latestHeight } = options;
  const state = await getSyncState(client, syncKey);
  if (backfill && state.complete) {
    return { pages: 0, matches: 0, blocks: 0, complete: true };
  }

  const previousMaxHeight = safeNumber(state.stats_json?.max_height);
  const activationHeight = config.wasmArbEconomicsStartHeight;
  const headHeight = Math.trunc(safeNumber(latestHeight));
  const persistedScannedHeight = Math.trunc(safeNumber(state.stats_json?.scanned_through_height));
  let scannedThroughHeight = Math.max(activationHeight - 1, persistedScannedHeight);
  if (!backfill && persistedScannedHeight < activationHeight - 1) {
    // Legacy head max_height is only an observed match: truncated or failed
    // descending scans can leave gaps below it. Only completed archive coverage
    // can safely seed the new contiguous cursor.
    const archive = await getSyncState(client, `${syncKey}-backfill`);
    if (archive.complete) {
      scannedThroughHeight = Math.max(
        scannedThroughHeight,
        Math.trunc(safeNumber(archive.stats_json?.target_height))
      );
    }
  }
  const resumeHead = !backfill
    && Boolean(state.next_page_token)
    && persistedScannedHeight >= activationHeight - 1
    && safeNumber(state.stats_json?.scan_start_height) >= activationHeight
    && safeNumber(state.stats_json?.target_height) >= safeNumber(state.stats_json?.scan_start_height);
  let startHeight = backfill ? activationHeight : resumeHead
    ? Math.trunc(safeNumber(state.stats_json.scan_start_height))
    : Math.max(activationHeight, scannedThroughHeight - ACTION_OVERLAP_BLOCKS);
  let targetHeight = backfill
    ? Math.trunc(safeNumber(state.stats_json?.target_height, latestHeight))
    : resumeHead
      ? Math.trunc(safeNumber(state.stats_json.target_height))
      : Math.min(headHeight, startHeight + COLLECTOR_HEAD_WINDOW_BLOCKS - 1);
  let page = backfill || resumeHead
    ? Math.max(1, Math.trunc(safeNumber(state.next_page_token, 1)))
    : 1;
  let pages = 0;
  let matchCount = 0;
  let blockCount = 0;
  let maxHeight = previousMaxHeight;
  let complete = Boolean(state.complete);
  let rangeComplete = false;
  const errors = [];
  const pageBudget = Math.max(1, maxPages);
  if (!backfill && (targetHeight > headHeight || targetHeight < startHeight)) {
    // A temporarily stale tip must not change a pending query's page offsets.
    errors.push(`Collector ${kind} search retains range ${startHeight}-${targetHeight} while latest height is ${headHeight}`);
  }

  while (!errors.length && pages < pageBudget) {
    let payload;
    try {
      payload = await fetchCollectorSearchPage(client, {
        kind,
        page,
        startHeight,
        endHeight: targetHeight,
        orderBy: backfill ? 'asc' : 'desc',
        backfill
      }, options);
    } catch (error) {
      errors.push(String(error?.message || error).slice(0, 500));
      break;
    }
    const matches = kind === 'tx'
      ? (Array.isArray(payload?.txs) ? payload.txs : [])
      : (Array.isArray(payload?.blocks) ? payload.blocks : []);
    const total = Math.max(0, Math.trunc(safeNumber(payload?.total_count)));
    if (!matches.length && backfill) {
      complete = true;
      break;
    }

    pages += 1;
    matchCount += matches.length;
    const candidates = kind === 'tx'
      ? normalizeCollectorTxSearchCandidates(matches)
      : normalizeCollectorBlockSearchCandidates(matches);
    blockCount += await enqueueBlocks(client, candidates);
    const heights = candidates.map((candidate) => candidate.height).filter((height) => height > 0);
    maxHeight = Math.max(maxHeight, ...heights, 0);
    const exhausted = matches.length < COLLECTOR_TX_PAGE_LIMIT
      || (total > 0 && page * COLLECTOR_TX_PAGE_LIMIT >= total);
    if (exhausted) {
      if (backfill) {
        complete = true;
        break;
      }
      // Empty successful windows also prove coverage; highest matched height
      // cannot represent quiet periods or partial-page completeness.
      scannedThroughHeight = Math.max(scannedThroughHeight, targetHeight);
      rangeComplete = true;
      if (targetHeight >= headHeight || pages >= pageBudget) break;
      startHeight = targetHeight + 1;
      targetHeight = Math.min(headHeight, startHeight + COLLECTOR_HEAD_WINDOW_BLOCKS - 1);
      page = 1;
      rangeComplete = false;
    } else {
      page += 1;
    }
    if (pages < pageBudget && config.wasmArbEconomicsRequestDelayMs > 0) {
      await sleep(config.wasmArbEconomicsRequestDelayMs);
    }
  }

  await setSyncState(client, syncKey, {
    cursorValue: String((backfill ? maxHeight : scannedThroughHeight) || ''),
    nextPageToken: (backfill ? !complete : !rangeComplete) ? String(page) : '',
    complete: backfill ? complete : Boolean(state.complete),
    stats: {
      ...(state.stats_json || {}),
      target_height: targetHeight,
      ...(!backfill ? {
        scan_start_height: startHeight,
        scanned_through_height: scannedThroughHeight,
        latest_height: headHeight
      } : {}),
      max_height: maxHeight,
      last_pages: pages,
      last_matches: matchCount,
      last_blocks: blockCount,
      errors,
      last_scanned_at: new Date().toISOString()
    }
  });
  return { pages, matches: matchCount, blocks: blockCount, complete, errors };
}

async function ingestCollectorTransfers(client, options = {}) {
  const fetchThor = options.fetchThorchain || fetchThorchain;
  const latestHeight = Math.trunc(safeNumber(options.latestHeight)) || Math.trunc(
    extractThorHeight(await fetchThor('/thorchain/lastblock'))
  );
  const result = {};
  for (const kind of ['tx', 'block']) {
    result[`${kind}Head`] = await scanCollectorSearchPages(client, {
      ...options,
      kind,
      latestHeight,
      syncKey: `collector-${kind}-search`,
      maxPages: config.wasmArbEconomicsTransferHeadPages,
      backfill: false
    });
    result[`${kind}Backfill`] = await scanCollectorSearchPages(client, {
      ...options,
      kind,
      latestHeight,
      syncKey: `collector-${kind}-search-backfill`,
      maxPages: config.wasmArbEconomicsTransferBackfillPages,
      backfill: true
    });
  }
  return result;
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

async function fetchOracleTrackingSample(height, client, options = {}) {
  if (typeof options.fetchOracleTrackingSample === 'function') {
    return options.fetchOracleTrackingSample(height);
  }
  const fetchThor = options.fetchThorchain || fetchThorchain;
  const fetchRpc = options.fetchRpc || fetchThorchainRpc;
  const snapshot = await (options.ensureMarketSnapshot || ensureThorchainMarketSnapshot)(
    client,
    height,
    {
      fetchThorchain: fetchThor,
      fetchRpc,
      fetchBlock: options.fetchOracleBlock,
      source: 'wasm-arb-oracle'
    }
  );
  return {
    height,
    blockTime: snapshot.blockTime,
    pools: snapshot.pools,
    oraclePrices: snapshot.oraclePrices
  };
}

async function persistOracleTrackingSample(client, height, options = {}) {
  const sample = await fetchOracleTrackingSample(height, client, options);
  const rows = buildWasmArbOracleTrackingRows(sample);
  if (!rows.length) {
    const error = new Error(`No comparable pool/oracle rows at height ${height}`);
    const pools = Array.isArray(sample?.pools) ? sample.pools : [];
    const oraclePrices = oraclePriceRows(sample);
    if (pools.length > 0 && oraclePrices.length === 0) {
      error.code = ORACLE_EMPTY_PRICES_CODE;
      error.oracleGapCandidate = true;
      error.blockTime = sample.blockTime || null;
    }
    throw error;
  }
  await upsertRows(client, 'wasm_arb_economics_oracle_samples', rows, {
    conflictColumns: ['height', 'pool_asset'],
    jsonColumns: ['source_json']
  });
  return rows.length;
}

function oraclePriceRows(sample) {
  return Array.isArray(sample?.oraclePrices?.prices)
    ? sample.oraclePrices.prices
    : Array.isArray(sample?.oraclePrices) ? sample.oraclePrices : [];
}

function hasPoolAndOracleSource(sample) {
  return Array.isArray(sample?.pools) && sample.pools.length > 0
    && oraclePriceRows(sample).length > 0;
}

async function clearEmptyOracleSnapshot(client, height, options = {}) {
  if (typeof options.clearOracleGapSnapshot === 'function') {
    return options.clearOracleGapSnapshot(height);
  }
  return client.query(
    `delete from thorchain_market_snapshots
     where height = $1
       and jsonb_array_length(oracle_prices_json) = 0`,
    [height]
  );
}

function previousOracleGapAttempt(state, height) {
  const saved = Math.max(0, Math.trunc(safeNumber(
    state.stats_json?.gap_attempts?.[String(height)]
  )));
  if (saved > 0) return saved;
  const priorErrors = Array.isArray(state.stats_json?.errors) ? state.stats_json.errors : [];
  return priorErrors.some((message) => (
    String(message).startsWith(`${height}: `)
      && String(message).includes('No comparable pool/oracle rows')
  )) ? 1 : 0;
}

export async function ingestOracleTracking(client, options = {}) {
  const state = await getSyncState(client, 'oracle:backfill');
  const stride = Math.max(1, Math.trunc(config.wasmArbEconomicsOracleStrideBlocks));
  const startHeight = Math.max(
    config.wasmArbEconomicsStartHeight,
    Math.trunc(config.wasmArbEconomicsOracleStartHeight)
  );
  const latestHeight = Math.max(startHeight, Math.trunc(safeNumber(options.latestHeight)));
  const limit = Math.max(1, Math.trunc(config.wasmArbEconomicsOracleSamplesPerRun));
  let cursor = Math.trunc(safeNumber(state.cursor_value));
  let nextHeight = cursor >= startHeight ? cursor + stride : startHeight;
  let processed = 0;
  let samples = 0;
  let observations = 0;
  const gapAttempts = { ...(state.stats_json?.gap_attempts || {}) };
  const gaps = Array.isArray(state.stats_json?.gaps) ? [...state.stats_json.gaps] : [];
  const confirmedGaps = [];
  const errors = [];

  while (nextHeight <= latestHeight && processed < limit) {
    try {
      observations += await persistOracleTrackingSample(client, nextHeight, options);
      delete gapAttempts[String(nextHeight)];
      cursor = nextHeight;
      nextHeight += stride;
      processed += 1;
      samples += 1;
    } catch (error) {
      if (error?.oracleGapCandidate) {
        const attempt = previousOracleGapAttempt({
          ...state,
          stats_json: { ...(state.stats_json || {}), gap_attempts: gapAttempts }
        }, nextHeight) + 1;
        gapAttempts[String(nextHeight)] = attempt;
        const retryAttempts = Math.max(
          1,
          Math.trunc(config.wasmArbEconomicsOracleGapRetryAttempts)
        );
        let isolatedGap = false;
        if (attempt >= retryAttempts && nextHeight < latestHeight) {
          try {
            const followingSample = await fetchOracleTrackingSample(
              nextHeight + 1,
              client,
              options
            );
            isolatedGap = hasPoolAndOracleSource(followingSample);
            if (!isolatedGap && oraclePriceRows(followingSample).length === 0) {
              await clearEmptyOracleSnapshot(client, nextHeight + 1, options);
            }
          } catch (confirmationError) {
            errors.push(
              `${nextHeight}: unable to confirm isolated Oracle gap: ${confirmationError?.message || confirmationError}`
            );
            break;
          }
        }
        if (isolatedGap) {
          const gap = {
            height: nextHeight,
            block_time: error.blockTime || null,
            reason: 'empty-oracle-prices',
            attempts: attempt,
            confirmed_at: new Date().toISOString()
          };
          const existingIndex = gaps.findIndex((row) => safeNumber(row?.height) === nextHeight);
          if (existingIndex >= 0) gaps[existingIndex] = gap;
          else gaps.push(gap);
          confirmedGaps.push(gap);
          delete gapAttempts[String(nextHeight)];
          cursor = nextHeight;
          nextHeight += stride;
          processed += 1;
          continue;
        }
        await clearEmptyOracleSnapshot(client, nextHeight, options);
      }
      errors.push(`${nextHeight}: ${error?.message || error}`);
      break;
    }
    if (config.wasmArbEconomicsRequestDelayMs > 0) {
      await sleep(config.wasmArbEconomicsRequestDelayMs);
    }
  }

  let headObservations = 0;
  if (latestHeight > cursor && !errors.length) {
    try {
      headObservations = await persistOracleTrackingSample(client, latestHeight, options);
    } catch (error) {
      errors.push(`head ${latestHeight}: ${error?.message || error}`);
    }
  }
  const complete = cursor + stride > latestHeight;
  await setSyncState(client, 'oracle:backfill', {
    cursorValue: String(cursor || ''),
    complete,
    stats: {
      ...(state.stats_json || {}),
      start_height: startHeight,
      target_height: latestHeight,
      stride_blocks: stride,
      last_samples: samples,
      last_observations: observations,
      head_height: latestHeight,
      head_observations: headObservations,
      gap_attempts: gapAttempts,
      gaps,
      last_confirmed_gaps: confirmedGaps,
      errors,
      last_scanned_at: new Date().toISOString()
    }
  });
  return {
    samples,
    observations,
    headObservations,
    cursor,
    latestHeight,
    complete,
    errors,
    confirmedGaps,
    gapCount: gaps.length
  };
}

async function fetchFinContractConfig(address, options = {}) {
  if (typeof options.fetchFinContractConfig === 'function') {
    return options.fetchFinContractConfig(address);
  }
  const fetchThor = options.fetchThorchain || fetchThorchain;
  const query = Buffer.from(JSON.stringify({ config: {} })).toString('base64');
  const payload = await fetchThor(
    `/cosmwasm/wasm/v1/contract/${address}/smart/${encodeURIComponent(query)}`
  );
  return payload?.data || payload || {};
}

async function fetchFinContracts(client, options = {}) {
  const fetchThor = options.fetchThorchain || fetchThorchain;
  const discovered = [];
  for (const rawCodeId of config.wasmArbEconomicsFinCodeIds) {
    const codeId = String(rawCodeId || '').trim();
    if (!/^\d+$/.test(codeId)) continue;
    const payload = await fetchThor(
      `/cosmwasm/wasm/v1/code/${codeId}/contracts?pagination.limit=200`
    );
    discovered.push(...(Array.isArray(payload?.contracts) ? payload.contracts : []).map((address) => ({
      address: normalizeAddress(address),
      codeId: Number(codeId)
    })));
  }
  const contracts = [...new Map(discovered.filter((row) => row.address).map((row) => [
    row.address,
    row
  ])).values()];
  if (!contracts.length) return [];

  const { rows: cachedRows } = await client.query(
    `select address, code_id, base_denom, quote_denom, config_json, observed_at, updated_at
     from wasm_arb_economics_fin_contracts
     where address = any($1::text[])`,
    [contracts.map((row) => row.address)]
  );
  const cached = new Map(cachedRows.map((row) => [normalizeAddress(row.address), row]));
  const metadataRows = [];
  const observedAt = new Date().toISOString();

  for (const contract of contracts) {
    const existing = cached.get(contract.address);
    if (existing?.base_denom && existing?.quote_denom) {
      metadataRows.push({
        address: contract.address,
        code_id: safeNumber(existing.code_id, contract.codeId),
        base_denom: String(existing.base_denom || '').toLowerCase(),
        quote_denom: String(existing.quote_denom || '').toLowerCase(),
        config_json: existing.config_json || {},
        observed_at: existing.observed_at || observedAt,
        updated_at: observedAt
      });
      continue;
    }
    try {
      const contractConfig = await fetchFinContractConfig(contract.address, options);
      const denoms = Array.isArray(contractConfig?.denoms) ? contractConfig.denoms : [];
      metadataRows.push({
        address: contract.address,
        code_id: contract.codeId,
        base_denom: String(denoms[0] || '').toLowerCase(),
        quote_denom: String(denoms[1] || '').toLowerCase(),
        config_json: contractConfig || {},
        observed_at: observedAt,
        updated_at: observedAt
      });
    } catch {
      metadataRows.push({
        address: contract.address,
        code_id: contract.codeId,
        base_denom: '',
        quote_denom: '',
        config_json: existing?.config_json || {},
        observed_at: observedAt,
        updated_at: observedAt
      });
    }
    if (config.wasmArbEconomicsRequestDelayMs > 0) {
      await sleep(config.wasmArbEconomicsRequestDelayMs);
    }
  }

  await upsertRows(client, 'wasm_arb_economics_fin_contracts', metadataRows, {
    conflictColumns: ['address'],
    jsonColumns: ['config_json']
  });
  return metadataRows.map((row) => ({
    address: normalizeAddress(row.address),
    denoms: [row.base_denom, row.quote_denom].filter(Boolean)
  }));
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

export async function scanCandidateBlocks(client, options = {}) {
  let finContracts;
  try {
    finContracts = await fetchFinContracts(client, options);
  } catch (error) {
    return {
      blocks: 0,
      events: 0,
      failures: 0,
      finContracts: 0,
      deferred: true,
      error: String(error?.message || error).slice(0, 500)
    };
  }
  const { rows: blocks } = await client.query(
    `select height, block_time, attempts
     from wasm_arb_economics_blocks
     where scan_version = $2
       and fetched_version < $2
       and height >= $3
       and next_retry_at <= now()
     order by height asc
     limit $1`,
    [
      Math.max(1, config.wasmArbEconomicsBlockMaxHeights),
      WASM_ARB_ACCOUNTING_VERSION,
      config.wasmArbEconomicsStartHeight
    ]
  );
  let attemptedBlocks = 0;
  let eventCount = 0;
  let failures = 0;

  for (const block of blocks) {
    try {
      const fetchRpc = options.fetchRpc || fetchThorchainRpc;
      const payload = await fetchRpc(
        '/block_results',
        { height: block.height },
        {
          cooldownClient: client,
          sharedCooldown: true,
          cooldownScope: FEE_BLOCK_COOLDOWN_SCOPE
        }
      );
      let blockTime = block.block_time;
      if (!Number.isFinite(Date.parse(blockTime || ''))) {
        const blockPayload = await (options.fetchBlock || fetchRpc)(
          '/block',
          { height: block.height },
          {
            cooldownClient: client,
            sharedCooldown: true,
            cooldownScope: FEE_BLOCK_COOLDOWN_SCOPE
          }
        );
        blockTime = blockPayload?.result?.block?.header?.time
          || blockPayload?.block?.header?.time
          || null;
      }
      if (!Number.isFinite(Date.parse(blockTime || ''))) {
        throw new Error(`Missing canonical block time for height ${block.height}`);
      }
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
             block_time = $3, event_count = $2, fetched_version = $4,
             fetched_at = now(), updated_at = now()
         where height = $1 and scan_version = $4`,
        [
          block.height,
          events.length,
          new Date(blockTime).toISOString(),
          WASM_ARB_ACCOUNTING_VERSION
        ]
      );
      attemptedBlocks += 1;
    } catch (error) {
      if (error?.skipProvider) break;
      attemptedBlocks += 1;
      failures += 1;
      const attempts = Math.max(1, safeNumber(block.attempts) + 1);
      const retrySeconds = Math.min(3600, 30 * 2 ** Math.min(7, attempts - 1));
      await client.query(
        `update wasm_arb_economics_blocks
         set status = 'error', attempts = attempts + 1, error = $2,
             next_retry_at = now() + ($3::text || ' seconds')::interval,
             updated_at = now()
         where height = $1 and scan_version = $4`,
        [
          block.height,
          String(error?.message || error).slice(0, 500),
          retrySeconds,
          WASM_ARB_ACCOUNTING_VERSION
        ]
      );
    }
    if (config.wasmArbEconomicsRequestDelayMs > 0) {
      await sleep(config.wasmArbEconomicsRequestDelayMs);
    }
  }
  return {
    blocks: attemptedBlocks,
    events: eventCount,
    failures,
    finContracts: finContracts.length
  };
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

function missingPoolCacheKey(poolAsset) {
  return `${MISSING_POOL_CACHE_PREFIX}${normalizeAsset(poolAsset)}`;
}

export function isUnsupportedPoolPriceError(error) {
  if (safeNumber(error?.status) === 400 || safeNumber(error?.statusCode) === 400) return true;
  const message = String(error?.message || error || '');
  return /400\s+Bad Request/i.test(message) && /history\/depths/i.test(message);
}

async function hasMissingPoolPriceCache(client, poolAsset, options = {}) {
  if (typeof options.isMissingPoolPriceCached === 'function') {
    return Boolean(await options.isMissingPoolPriceCached(poolAsset));
  }
  const { rows } = await client.query(
    `select 1
     from api_response_cache
     where cache_key = $1
       and expires_at > now()
     limit 1`,
    [missingPoolCacheKey(poolAsset)]
  );
  return Boolean(rows[0]);
}

async function cacheMissingPoolPrice(client, poolAsset, error, options = {}) {
  if (typeof options.cacheMissingPoolPrice === 'function') {
    return options.cacheMissingPoolPrice(poolAsset, error);
  }
  const ttlMs = Math.max(1000, Math.trunc(config.wasmArbEconomicsMissingPoolCacheMs));
  return client.query(
    `insert into api_response_cache (cache_key, payload_json, fetched_at, expires_at)
     values ($1, $2, now(), $3)
     on conflict (cache_key)
     do update set
       payload_json = excluded.payload_json,
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
    [
      missingPoolCacheKey(poolAsset),
      {
        kind: 'missing-midgard-depth-pool',
        poolAsset: normalizeAsset(poolAsset),
        status: safeNumber(error?.status || error?.statusCode, 400),
        message: String(error?.message || error).slice(0, 500)
      },
      new Date(Date.now() + ttlMs).toISOString()
    ]
  );
}

export async function priceRujiraFeeEvents(client, options = {}) {
  const { rows } = await client.query(
    `select event_key, height, block_time, tx_id, event_origin, event_ordinal,
            source_contract, fee_kind, denom, amount_base, amount,
            price_usd, fee_usd, price_source, wasm_linked, raw_event, observed_at
     from wasm_arb_economics_rujira_fees
     where event_key like 'wasm-arb-rujira-fee:v2:%'
       and fee_usd is null
     order by block_time asc
     limit 5000`
  );
  if (!rows.length) return { priced: 0, unpriced: 0, errors: [], unsupportedDenoms: [] };

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
  const unsupportedDenoms = [];
  const denoms = [...new Set(rows.flatMap((row) => {
    const hint = row.raw_event?.finExecutionPrice;
    return [row.denom, hint?.baseDenom, hint?.quoteDenom]
      .map((denom) => String(denom || '').toLowerCase())
      .filter(Boolean);
  }))];
  for (const denom of denoms) {
    if (denom === 'rune' || isStableDenom(denom)) continue;
    const poolAsset = denomToWasmArbPoolAsset(denom);
    if (await hasMissingPoolPriceCache(client, poolAsset, options)) {
      unsupportedDenoms.push(denom);
      continue;
    }
    try {
      priceMaps.set(denom, await fetchPriceIntervals(
        poolAsset,
        unixSeconds(rows[0].block_time),
        unixSeconds(rows.at(-1).block_time),
        { ...options, client }
      ));
    } catch (error) {
      if (isUnsupportedPoolPriceError(error)) {
        await cacheMissingPoolPrice(client, poolAsset, error, options);
        unsupportedDenoms.push(denom);
      } else {
        errors.push(`${denom}: ${error?.message || error}`);
      }
    }
  }

  const directPrice = (denom, bucket) => {
    const normalized = String(denom || '').toLowerCase();
    if (normalized === 'rune') {
      return { price: runePrices.get(bucket) || 0, source: 'midgard-rune-5min' };
    }
    if (isStableDenom(normalized)) return { price: 1, source: 'stable-parity' };
    return {
      price: priceMaps.get(normalized)?.get(bucket) || 0,
      source: 'midgard-depth-5min'
    };
  };

  const pricedRows = [];
  for (const row of rows) {
    const denom = String(row.denom || '').toLowerCase();
    const bucket = floorBucket(unixSeconds(row.block_time));
    let { price, source } = directPrice(denom, bucket);
    const hint = row.raw_event?.finExecutionPrice;
    if (!(price > 0) && hint) {
      const baseDenom = String(hint?.baseDenom || '').toLowerCase();
      const quoteDenom = String(hint?.quoteDenom || '').toLowerCase();
      const base = directPrice(baseDenom, bucket);
      const quote = directPrice(quoteDenom, bucket);
      const derived = deriveFinExecutionPriceUsd({
        denom,
        hint,
        basePriceUsd: base.price,
        quotePriceUsd: quote.price
      });
      if (derived) {
        const counter = derived.counterDenom === baseDenom ? base : quote;
        price = derived.priceUsd;
        source = `fin-execution:${derived.counterDenom}:${counter.source}`;
      }
    }
    if (!(price > 0)) continue;
    pricedRows.push({
      ...row,
      price_usd: price,
      fee_usd: safeNumber(row.amount) * price,
      price_source: source,
      raw_event: row.raw_event || {}
    });
  }
  await upsertRows(client, 'wasm_arb_economics_rujira_fees', pricedRows, {
    conflictColumns: ['event_key'],
    jsonColumns: ['raw_event']
  });
  return {
    priced: pricedRows.length,
    unpriced: rows.length - pricedRows.length,
    errors,
    unsupportedDenoms
  };
}

function findMimirValue(payload) {
  for (const [key, value] of Object.entries(payload || {})) {
    if (key.replaceAll('_', '').toLowerCase() === 'wasmarbslipminbps') {
      return Math.trunc(safeNumber(value));
    }
  }
  return null;
}

async function fetchArbContractConfig(options = {}) {
  if (typeof options.fetchArbContractConfig === 'function') {
    return options.fetchArbContractConfig();
  }
  const fetchThor = options.fetchThorchain || fetchThorchain;
  const query = Buffer.from(JSON.stringify({ config: {} })).toString('base64');
  const payload = await fetchThor(
    `/cosmwasm/wasm/v1/contract/${WASM_ARB_CONTRACT}/smart/${encodeURIComponent(query)}`
  );
  return payload?.data || payload || {};
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
  const [mimir, arbConfig] = await Promise.all([
    fetchThor('/thorchain/mimir'),
    fetchArbContractConfig(options)
  ]);
  const value = findMimirValue(mimir);
  if (value === null) throw new Error('WasmArbSlipMinBps is missing from THORNode Mimir');
  const spreadBps = Math.max(0, Math.trunc(safeNumber(arbConfig?.spread_bps)));
  const height = Math.trunc(safeNumber(options.latestHeight));
  const share = await currentTcShare(client);
  const { rows } = await client.query(
    `select activation_height, mimir_value, previous_mimir_value,
            spread_bps, previous_spread_bps, tc_share, metadata_json
     from wasm_arb_economics_regimes
     order by activation_height desc`
  );
  const previous = rows[0] || null;
  const previousMimir = rows.find((row) => (
    String(row.metadata_json?.change_kind || '').includes('mimir')
      || row.previous_mimir_value == null
      || safeNumber(row.mimir_value) !== safeNumber(row.previous_mimir_value)
  )) || previous;
  const previousSpread = rows.find((row) => row.spread_bps != null) || null;
  const tcShare = share ?? safeNumber(previous?.tc_share, 0.5);
  const mimirChanged = !previousMimir || value !== safeNumber(previousMimir.mimir_value);
  const spreadChanged = !previousSpread || spreadBps !== safeNumber(previousSpread.spread_bps);
  const shareChanged = !previous
    || Math.abs(tcShare - safeNumber(previous.tc_share, 0.5)) > 1e-9;
  const changed = mimirChanged || spreadChanged || shareChanged;
  if (!changed) {
    return { changed: false, height, mimirValue: value, spreadBps, tcShare };
  }
  const changeKind = [
    ...(mimirChanged ? ['mimir'] : []),
    ...(spreadChanged ? ['spread'] : []),
    ...(shareChanged ? ['tc-share'] : [])
  ].join('+');

  await client.query(
    `insert into wasm_arb_economics_regimes (
       activation_height, activation_time, mimir_value, previous_mimir_value,
       spread_bps, previous_spread_bps, arb_contract, trade_collector,
       base_layer_collector, tc_share, source, observed_at, metadata_json
     ) values ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9,
               'scheduled-observation', now(), $10)
     on conflict (activation_height) do update set
       mimir_value = excluded.mimir_value,
       previous_mimir_value = excluded.previous_mimir_value,
       spread_bps = excluded.spread_bps,
       previous_spread_bps = excluded.previous_spread_bps,
       tc_share = excluded.tc_share,
       observed_at = excluded.observed_at,
       metadata_json = excluded.metadata_json`,
    [
      height,
      value,
      mimirChanged && previousMimir ? safeNumber(previousMimir.mimir_value) : value,
      spreadBps,
      spreadChanged && previousSpread ? safeNumber(previousSpread.spread_bps) : spreadBps,
      WASM_ARB_CONTRACT,
      RUJIRA_TRADE_COLLECTOR,
      BASE_LAYER_COLLECTOR,
      tcShare,
      {
        change_kind: changeKind,
        precision: 'observed within scheduler interval'
      }
    ]
  );
  return { changed: true, height, mimirValue: value, spreadBps, tcShare, changeKind };
}

async function pruneOldRows(client) {
  const days = Math.max(30, Math.trunc(config.wasmArbEconomicsRetentionDays));
  const tables = [
    ['wasm_arb_economics_network_buckets', 'bucket_start'],
    ['wasm_arb_economics_actions', 'block_time'],
    ['wasm_arb_economics_rujira_fees', 'block_time'],
    ['wasm_arb_economics_blocks', 'block_time'],
    ['wasm_arb_economics_oracle_samples', 'block_time']
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
  const snapshots = await pruneThorchainMarketSnapshots(client, 30);
  deleted.thorchain_market_snapshots = snapshots.rowCount || 0;
  return deleted;
}

export async function wasmRuntimeOptions(client, options = {}, lane = 'combined') {
  const fetchThor = options.fetchThorchain || ((path, fetchOptions = {}) => fetchThorchain(path, {
    timeoutMs: WASM_THORNODE_REQUEST_TIMEOUT_MS,
    ...fetchOptions
  }));
  const latestHeight = Math.trunc(safeNumber(options.latestHeight)) || Math.trunc(
    extractThorHeight(await fetchThor('/thorchain/lastblock', {
      cooldownClient: client,
      sharedCooldown: true,
      cooldownScope: `wasm-${lane}-head`
    }))
  );
  return { ...options, fetchThorchain: fetchThor, latestHeight };
}

async function runWasmArbActivityLane(client, runtimeOptions) {
  const stats = {};
  stats.network = await ingestNetworkBuckets(client, runtimeOptions);
  stats.actions = await ingestActions(client, runtimeOptions);
  try {
    stats.regime = await observeRegime(client, runtimeOptions);
  } catch (error) {
    stats.regime = { changed: false, error: error?.message || String(error) };
  }
  stats.pruned = await pruneOldRows(client);
  return stats;
}

async function runWasmArbFeeLane(client, runtimeOptions) {
  return {
    collectorTransfers: await ingestCollectorTransfers(client, runtimeOptions),
    blocks: await scanCandidateBlocks(client, runtimeOptions),
    pricing: await priceRujiraFeeEvents(client, runtimeOptions)
  };
}

async function runWasmArbOracleLane(client, runtimeOptions) {
  return { oracle: await ingestOracleTracking(client, runtimeOptions) };
}

export async function runWasmArbActivityIngestion(client, options = {}) {
  return runWasmArbActivityLane(client, await wasmRuntimeOptions(client, options, 'activity'));
}

export async function runWasmArbFeeIngestion(client, options = {}) {
  return runWasmArbFeeLane(client, await wasmRuntimeOptions(client, options, 'fees'));
}

export async function runWasmArbOracleIngestion(client, options = {}) {
  return runWasmArbOracleLane(client, await wasmRuntimeOptions(client, options, 'oracle'));
}

export async function runWasmArbEconomicsIngestion(client, options = {}) {
  const runtimeOptions = await wasmRuntimeOptions(client, options, 'combined');
  return {
    ...await runWasmArbActivityLane(client, runtimeOptions),
    ...await runWasmArbFeeLane(client, runtimeOptions),
    ...await runWasmArbOracleLane(client, runtimeOptions)
  };
}
