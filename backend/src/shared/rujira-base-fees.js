import { createHash } from 'node:crypto';
import { query } from '../db/pool.js';
import { upsertRows } from '../db/sql.js';
import { config } from '../lib/config.js';
import { chunkArray, safeNumber, sleep, toIsoString } from '../lib/utils.js';
import { executeDuneQueryRows, summarizeDuneError } from './dune.js';
import { fetchMidgard, isMidgardRateLimitError } from './midgard.js';

const ACTION_SYNC_KEY = 'rujira-thorchain-swap-actions:v1';
const ACTION_PAGE_LIMIT = 50;
const RPC_REQUEST_TIMEOUT_MS = 10000;
const HISTORICAL_ACTION_RETRY_MS = 60 * 60 * 1000;

export const BASE_LAYER_REVENUE_COLLECTOR =
  'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr';
export const RUJI_SWAP_REVENUE_COLLECTOR =
  'thor1mcy9jtp4kzl8q2lvdgfgsl8jvqrf504uphkf0pz2p9wud8tsntesjvccew';
export const RUJIRA_THORCHAIN_SWAP_CONTRACT =
  'thor1n5a08r0zvmqca39ka2tgwlkjy9ugalutk7fjpzptfppqcccnat2ska5t4g';

const KNOWN_REVENUE_COLLECTORS = Object.freeze({
  [BASE_LAYER_REVENUE_COLLECTOR]: 'Base Layer collector',
  [RUJI_SWAP_REVENUE_COLLECTOR]: 'RUJI Swap collector',
  thor1gm8q2gr25nzzsxzdp2mpja4hyvyhjlr4s6krcsgv2y953uu0js3qhwpus7: 'RUJI Trade collector',
  thor1jduxxzpyyvrgzx7zcnl7e5cdj34tnq5jxy00a4wp86szye25dndq575c0y: 'Other Core Apps collector',
  thor132u9qpm9gfdqtgwxwl8ty409s6zmewfrum2k6wvtvtyphdn5urzsej764l: 'RUJI Index collector'
});

const BASE_FEE_EVENT_KEY_VERSION = 'rujira-base-fee:v2';
const DUNE_BASE_FEE_CLASSIFICATIONS = Object.freeze({
  base_collector_conversion: {
    included: true,
    sourceContract: BASE_LAYER_REVENUE_COLLECTOR
  },
  app_revenue_conversion: {
    included: true,
    requireSourceContract: true
  },
  fin_base_layer_execution: {
    included: true,
    requireSourceContract: true
  },
  ghost_base_layer_execution: {
    included: true,
    requireSourceContract: true
  },
  app_layer_contract_execution: {
    included: true,
    requireSourceContract: true
  },
  mixed_app_layer_context: {
    included: true,
    requireSourceContract: true
  },
  ruji_swap_revenue_excluded: {
    included: false,
    sourceContract: RUJI_SWAP_REVENUE_COLLECTOR
  },
  direct_ruji_swap_excluded: {
    included: false,
    sourceContract: RUJIRA_THORCHAIN_SWAP_CONTRACT
  },
  mixed_or_excluded_context: {
    included: false
  }
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalKeyPart(value) {
  return String(value ?? '')
    .trim()
    .replaceAll('%', '%25')
    .replaceAll('|', '%7C');
}

function normalizeBaseRuneAmount(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return '';
  return text.replace(/^0+(?=\d)/, '');
}

function normalizeRujiraBaseFeeIdentity(input, fallback = '') {
  const height = Math.trunc(safeNumber(input?.height, 0));
  const swapId = String(input?.swap_id || '').trim().toUpperCase();
  const pool = normalizeAsset(input?.pool);
  const toAddress = String(input?.to_address || '').trim().toLowerCase();
  const memo = String(input?.memo || '').trim();
  const liquidityFeeBase = normalizeBaseRuneAmount(input?.liquidity_fee_base);
  const identifier = swapId || String(fallback || '').trim();
  const canonicalKey = height > 0 && identifier
    ? [
        BASE_FEE_EVENT_KEY_VERSION,
        height,
        canonicalKeyPart(identifier),
        canonicalKeyPart(pool),
        canonicalKeyPart(toAddress),
        canonicalKeyPart(memo),
        canonicalKeyPart(liquidityFeeBase || '0')
      ].join('|')
    : '';

  return {
    canonical_key: canonicalKey,
    height,
    swap_id: swapId,
    pool,
    chain: String(input?.chain || '').trim().toUpperCase(),
    from_address: String(input?.from_address || '').trim().toLowerCase(),
    to_address: toAddress,
    memo,
    liquidity_fee_base: liquidityFeeBase
  };
}

function parseStrictBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  const text = String(value || '').trim().toLowerCase();
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no'].includes(text)) return false;
  return null;
}

function isFiniteNonNegativeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0;
}

function closeEnough(left, right) {
  const difference = Math.abs(Number(left) - Number(right));
  const scale = Math.max(Math.abs(Number(left)), Math.abs(Number(right)), 1);
  return difference <= Math.max(1e-10, scale * 1e-6);
}

function makeLegacySourceProvenance(contextOrigin, sourceEventKey) {
  return {
    legacy: {
      context_origin: String(contextOrigin || ''),
      source_event_key: String(sourceEventKey || '')
    }
  };
}

function makeDuneSourceProvenance(sourceEventKey) {
  return {
    dune: {
      query_id: String(config.rujiraBaseFeesDuneQueryId || ''),
      context_origin: 'dune-wasm-tx',
      source_event_keys: [String(sourceEventKey || '')].filter(Boolean)
    }
  };
}

function getAttr(event, key) {
  return event?.attributes?.find((attr) => attr?.key === key)?.value || '';
}

function attrsToObject(event) {
  const output = {};
  for (const attr of event?.attributes || []) {
    if (!attr?.key) continue;
    output[attr.key] = attr.value || '';
  }
  return output;
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

function addHours(value, hours) {
  const date = new Date(value);
  date.setUTCHours(date.getUTCHours() + hours);
  return date;
}

function parseUtcDateTime(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDuneDateTime(value) {
  const date = value instanceof Date ? value : parseUtcDateTime(value);
  if (!date) return '';
  return date.toISOString().slice(0, 19).replace('T', ' ');
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

function truncateValue(value, maxLength = 180) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function compactEvent(event) {
  const attrs = attrsToObject(event);
  const keys = [
    '_contract_address',
    'amount',
    'base',
    'bid',
    'borrower',
    'coin',
    'denom',
    'delegate',
    'from',
    'memo',
    'min_return',
    'mode',
    'offer',
    'pool',
    'price',
    'quote',
    'rate',
    'returned',
    'side',
    'to'
  ];
  return {
    type: event?.type || '',
    attrs: Object.fromEntries(
      keys
        .filter((key) => attrs[key] !== undefined)
        .map((key) => [key, truncateValue(attrs[key])])
    )
  };
}

function denomToThorAsset(denom) {
  const raw = String(denom || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'rune') return 'THOR.RUNE';
  if (raw.startsWith('x/ghost-vault/')) return denomToThorAsset(raw.slice('x/ghost-vault/'.length));
  if (raw.startsWith('x/')) return `THOR.${raw.slice(2).toUpperCase()}`;
  if (raw.startsWith('thor.')) return raw.toUpperCase();
  if (raw.includes('-')) return raw.toUpperCase();
  return `THOR.${raw.toUpperCase()}`;
}

function normalizeAsset(value) {
  return String(value || '').trim().toUpperCase().replaceAll('~', '-');
}

function parseAmountDenom(value) {
  const match = String(value || '').trim().match(/^(\d+)([A-Za-z0-9./_~-].*)$/);
  if (!match) {
    return null;
  }
  return {
    amount: match[1],
    denom: match[2].toLowerCase(),
    asset: denomToThorAsset(match[2])
  };
}

function parseCoin(value) {
  const match = String(value || '').trim().match(/^(\d+)\s+(.+)$/);
  if (!match) {
    return null;
  }
  return {
    amount: match[1],
    asset: match[2]
  };
}

function memoAmountMatchesCoin(memoAmount, coin) {
  const amount = parseAmountDenom(memoAmount);
  const parsedCoin = parseCoin(coin);
  if (!amount || !parsedCoin) {
    return false;
  }
  return amount.amount === parsedCoin.amount && normalizeAsset(amount.asset) === normalizeAsset(parsedCoin.asset);
}

function collectRevenueRuns(events) {
  return events
    .filter((event) => event?.type === 'wasm-rujira-revenue/run')
    .map((event) => ({
      contract: getAttr(event, '_contract_address'),
      denom: getAttr(event, 'denom'),
      mode: getAttr(event, 'mode'),
      event: compactEvent(event)
    }));
}

function collectThorchainSwapMemos(events) {
  return events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === 'wasm-rujira-thorchain-swap/swap')
    .filter(({ event }) => getAttr(event, '_contract_address') === RUJIRA_THORCHAIN_SWAP_CONTRACT)
    .map(({ event, index }) => ({
      index,
      memo: getAttr(event, 'memo'),
      amount: getAttr(event, 'amount'),
      ammFee: getAttr(event, 'amm_fee'),
      reserveFee: getAttr(event, 'reserve_fee'),
      minReturn: getAttr(event, 'min_return'),
      returned: getAttr(event, 'returned'),
      event: compactEvent(event)
    }))
    .filter((row) => row.memo && !row.memo.startsWith('%%skipped%%'));
}

function collectEventsByPrefix(events, prefix) {
  return events
    .filter((event) => String(event?.type || '').startsWith(prefix))
    .map((event) => ({
      type: event.type,
      contract: getAttr(event, '_contract_address'),
      event: compactEvent(event)
    }));
}

function lastContract(rows) {
  return [...rows].reverse().find((row) => row.contract)?.contract || '';
}

function sourceLabelForClassification(classification, contract) {
  if (KNOWN_REVENUE_COLLECTORS[contract]) {
    return KNOWN_REVENUE_COLLECTORS[contract];
  }
  if (classification === 'fin_base_layer_execution') {
    return contract ? `RUJI Trade / FIN ${contract.slice(0, 12)}...` : 'RUJI Trade / FIN';
  }
  if (classification === 'ghost_base_layer_execution') {
    return contract ? `Ghost ${contract.slice(0, 12)}...` : 'Ghost';
  }
  if (classification === 'app_layer_contract_execution') {
    return contract ? `Rujira app ${contract.slice(0, 12)}...` : 'Rujira app';
  }
  if (classification === 'direct_ruji_swap_excluded') {
    return 'Direct RUJI Swap path';
  }
  return classification.replaceAll('_', ' ');
}

function classifyContext({ revenueRuns, finEvents, ghostEvents, appEvents }) {
  if (revenueRuns.length) {
    const rujiSwapRun = revenueRuns.find((run) => run.contract === RUJI_SWAP_REVENUE_COLLECTOR);
    if (rujiSwapRun) {
      return {
        classification: 'ruji_swap_revenue_excluded',
        included: false,
        source_contract: rujiSwapRun.contract,
        source_label: KNOWN_REVENUE_COLLECTORS[rujiSwapRun.contract],
        source_denom: rujiSwapRun.denom || ''
      };
    }

    const knownRun = [...revenueRuns].reverse().find((run) => KNOWN_REVENUE_COLLECTORS[run.contract]) || revenueRuns.at(-1);
    const classification = knownRun.contract === BASE_LAYER_REVENUE_COLLECTOR
      ? 'base_collector_conversion'
      : 'app_revenue_conversion';
    return {
      classification,
      included: true,
      source_contract: knownRun.contract || '',
      source_label: KNOWN_REVENUE_COLLECTORS[knownRun.contract] || sourceLabelForClassification(classification, knownRun.contract),
      source_denom: knownRun.denom || ''
    };
  }

  if (finEvents.length) {
    const contract = lastContract(finEvents);
    return {
      classification: 'fin_base_layer_execution',
      included: true,
      source_contract: contract,
      source_label: sourceLabelForClassification('fin_base_layer_execution', contract),
      source_denom: ''
    };
  }

  if (ghostEvents.length) {
    const contract = lastContract(ghostEvents);
    return {
      classification: 'ghost_base_layer_execution',
      included: true,
      source_contract: contract,
      source_label: sourceLabelForClassification('ghost_base_layer_execution', contract),
      source_denom: ''
    };
  }

  const otherContract = lastContract(appEvents);
  if (otherContract) {
    return {
      classification: 'app_layer_contract_execution',
      included: true,
      source_contract: otherContract,
      source_label: sourceLabelForClassification('app_layer_contract_execution', otherContract),
      source_denom: ''
    };
  }

  return {
    classification: 'direct_ruji_swap_excluded',
    included: false,
    source_contract: RUJIRA_THORCHAIN_SWAP_CONTRACT,
    source_label: 'Direct RUJI Swap path',
    source_denom: ''
  };
}

function inferMemoContexts(events, origin) {
  const memos = collectThorchainSwapMemos(events);
  if (!memos.length) {
    return [];
  }

  let previousMemoIndex = -1;
  return memos.map((memo) => {
    const windowEvents = events.slice(previousMemoIndex + 1, memo.index + 1);
    previousMemoIndex = memo.index;
    const contextEvents = windowEvents.length > 1 ? windowEvents : events;
    const revenueRuns = collectRevenueRuns(contextEvents);
    const finEvents = collectEventsByPrefix(contextEvents, 'wasm-rujira-fin/');
    const ghostEvents = [
      ...collectEventsByPrefix(contextEvents, 'wasm-rujira-ghost-vault/'),
      ...collectEventsByPrefix(contextEvents, 'wasm-rujira-ghost-mint/'),
      ...collectEventsByPrefix(contextEvents, 'wasm-rujira-ghost-credit/')
    ];
    const appEvents = contextEvents
      .filter((event) => String(event?.type || '').startsWith('wasm-rujira-'))
      .filter((event) => event.type !== 'wasm-rujira-thorchain-swap/swap')
      .filter((event) => event.type !== 'wasm-rujira-revenue/run')
      .map((event) => ({
        type: event.type,
        contract: getAttr(event, '_contract_address'),
        event: compactEvent(event)
      }));
    const classification = classifyContext({ revenueRuns, finEvents, ghostEvents, appEvents });

    return {
      origin,
      memo: memo.memo,
      amount: memo.amount,
      classification: classification.classification,
      included: classification.included,
      source_contract: classification.source_contract,
      source_label: classification.source_label,
      source_denom: classification.source_denom,
      context_json: {
        memo,
        revenueRuns,
        finEvents: finEvents.slice(0, 8),
        ghostEvents: ghostEvents.slice(0, 8),
        appEvents: appEvents.slice(0, 8)
      }
    };
  });
}

function mergeAmbiguousContexts(candidates) {
  const includedCandidates = candidates.filter((candidate) => candidate.included);
  const excludedCandidates = candidates.filter((candidate) => !candidate.included);
  const included = includedCandidates.length > 0 && excludedCandidates.length === 0;
  const contracts = [...new Set(candidates.map((candidate) => candidate.source_contract).filter(Boolean))];
  const labels = [...new Set(candidates.map((candidate) => candidate.source_label).filter(Boolean))];

  return {
    origin: candidates.map((candidate) => candidate.origin).join(','),
    memo: candidates[0]?.memo || '',
    amount: '',
    classification: included ? 'mixed_app_layer_context' : 'mixed_or_excluded_context',
    included,
    source_contract: contracts[0] || '',
    source_label: labels.length ? labels.join(' / ') : 'Mixed Rujira context',
    source_denom: '',
    context_json: {
      ambiguous: true,
      candidates: candidates.map((candidate) => ({
        origin: candidate.origin,
        amount: candidate.amount,
        classification: candidate.classification,
        included: candidate.included,
        source_contract: candidate.source_contract,
        source_label: candidate.source_label,
        source_denom: candidate.source_denom
      }))
    }
  };
}

function pickContextForSwap(finalSwap, candidates, idContextMap) {
  const byId = idContextMap.get(finalSwap.id);
  if (byId) {
    return byId;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  const includedCandidates = candidates.filter((candidate) => candidate.included);
  if (includedCandidates.length === 1 && includedCandidates.length === candidates.length) {
    return includedCandidates[0];
  }
  return mergeAmbiguousContexts(candidates);
}

export function parseRujiraBaseFeeBlock(height, blockResults, options = {}) {
  const result = blockResults?.result || blockResults || {};
  const txsResults = Array.isArray(result.txs_results) ? result.txs_results : [];
  const finalizeEvents = Array.isArray(result.finalize_block_events) ? result.finalize_block_events : [];
  const contexts = [];

  for (const [index, tx] of txsResults.entries()) {
    const txContexts = inferMemoContexts(tx?.events || [], `tx_${index}`);
    contexts.push(...txContexts);
  }

  contexts.push(...inferMemoContexts(finalizeEvents, 'finalize_block'));

  const finalSwaps = finalizeEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === 'swap')
    .map(({ event, index }) => {
      const attrs = attrsToObject(event);
      return {
        index,
        id: attrs.id || '',
        memo: attrs.memo || '',
        from: attrs.from || '',
        attrs,
        event
      };
    })
    .filter((row) => row.from === RUJIRA_THORCHAIN_SWAP_CONTRACT)
    .filter((row) => row.memo);

  const candidatesByMemo = new Map();
  for (const context of contexts) {
    if (!candidatesByMemo.has(context.memo)) {
      candidatesByMemo.set(context.memo, []);
    }
    candidatesByMemo.get(context.memo).push(context);
  }

  const idContextMap = new Map();
  for (const finalSwap of finalSwaps) {
    const candidates = candidatesByMemo.get(finalSwap.memo) || [];
    const matching = candidates.filter((candidate) => memoAmountMatchesCoin(candidate.amount, finalSwap.attrs.coin));
    if (matching.length === 1 && finalSwap.id) {
      idContextMap.set(finalSwap.id, matching[0]);
    }
  }

  const blockTime = options.blockTime || null;
  const parsedEvents = [];
  const warnings = [];

  for (const finalSwap of finalSwaps) {
    const candidates = candidatesByMemo.get(finalSwap.memo) || [];
    if (!candidates.length) {
      continue;
    }

    const context = pickContextForSwap(finalSwap, candidates, idContextMap);
    if (context?.context_json?.ambiguous) {
      warnings.push({
        height,
        type: 'ambiguous_memo_context',
        memo: finalSwap.memo,
        swap_id: finalSwap.id,
        candidate_count: candidates.length
      });
    }

    const sourceEventKey = sha256([
      height,
      finalSwap.index,
      finalSwap.id,
      finalSwap.attrs.pool || '',
      finalSwap.attrs.coin || '',
      finalSwap.memo,
      finalSwap.attrs.liquidity_fee_in_rune || '0'
    ].join('|'));
    const identity = normalizeRujiraBaseFeeIdentity({
      height,
      swap_id: finalSwap.id,
      pool: finalSwap.attrs.pool,
      chain: finalSwap.attrs.chain,
      from_address: finalSwap.attrs.from,
      to_address: finalSwap.attrs.to,
      memo: finalSwap.memo,
      liquidity_fee_base: finalSwap.attrs.liquidity_fee_in_rune || '0'
    }, `legacy:${sourceEventKey}`);
    const feeBase = identity.liquidity_fee_base || '0';

    parsedEvents.push({
      event_key: identity.canonical_key,
      canonical_key: identity.canonical_key,
      height: identity.height,
      block_time: blockTime,
      swap_id: identity.swap_id,
      pool: identity.pool,
      chain: identity.chain,
      from_address: identity.from_address,
      to_address: identity.to_address,
      coin: finalSwap.attrs.coin || '',
      memo: identity.memo,
      liquidity_fee_base: feeBase,
      liquidity_fee_rune: baseRuneToNumber(feeBase),
      rune_price_usd: 0,
      liquidity_fee_usd: 0,
      classification: context.classification,
      included: Boolean(context.included),
      source_contract: context.source_contract || '',
      source_label: context.source_label || '',
      source_denom: context.source_denom || '',
      context_origin: context.origin || '',
      source: 'legacy',
      source_provenance: makeLegacySourceProvenance(context.origin, sourceEventKey),
      raw_event: compactEvent(finalSwap.event),
      context_json: {
        ...(context.context_json || {}),
        source: 'legacy',
        source_event_key: sourceEventKey
      }
    });
  }

  return {
    events: parsedEvents,
    scan: {
      height,
      context_count: contexts.length,
      final_rujira_swap_count: finalSwaps.length,
      matched_event_count: parsedEvents.length,
      included_event_count: parsedEvents.filter((event) => event.included).length,
      excluded_event_count: parsedEvents.filter((event) => !event.included).length,
      warnings,
      contexts: contexts.map((context) => ({
        origin: context.origin,
        memo: context.memo,
        amount: context.amount,
        classification: context.classification,
        included: context.included,
        source_contract: context.source_contract,
        source_label: context.source_label,
        source_denom: context.source_denom
      }))
    }
  };
}

function normalizeMidgardAction(action) {
  const actionDate = parseDateNs(action?.date);
  const txId = String(action?.in?.[0]?.txID || action?.out?.[0]?.txID || '').trim();
  const memo = String(action?.metadata?.swap?.memo || '').trim();
  const actionKey = sha256(JSON.stringify({
    height: action?.height,
    date: action?.date,
    txId,
    memo,
    in: action?.in || [],
    out: action?.out || []
  }));

  return {
    action_key: actionKey,
    height: Number(action?.height) || 0,
    action_date: actionDate ? actionDate.toISOString() : null,
    tx_id: txId,
    memo,
    status: String(action?.status || ''),
    raw_action: action || {}
  };
}

async function fetchRujiraSwapActionPage(nextPageToken = '') {
  const params = new URLSearchParams({
    address: RUJIRA_THORCHAIN_SWAP_CONTRACT,
    type: 'swap',
    limit: String(ACTION_PAGE_LIMIT)
  });
  if (nextPageToken) {
    params.set('nextPageToken', nextPageToken);
  } else {
    params.set('offset', '0');
  }

  return fetchMidgard(`/actions?${params.toString()}`, {
    bases: config.rujiraBaseFeesMidgardUrls,
    validateResponse: (_path, data) => !Array.isArray(data?.actions)
  });
}

async function fetchRujiraSwapActionForwardPage({ fromHeight = 0, prevPageToken = '' } = {}) {
  const params = new URLSearchParams({
    address: RUJIRA_THORCHAIN_SWAP_CONTRACT,
    type: 'swap',
    limit: String(ACTION_PAGE_LIMIT)
  });
  if (prevPageToken) {
    params.set('prevPageToken', prevPageToken);
  } else {
    params.set('fromHeight', String(Math.max(1, Math.trunc(Number(fromHeight) || 1))));
  }

  return fetchMidgard(`/actions?${params.toString()}`, {
    bases: config.rujiraBaseFeesMidgardUrls,
    validateResponse: (_path, data) => !Array.isArray(data?.actions)
  });
}

function createHttpError(message, details = {}) {
  const error = new Error(message);
  error.status = details.status || 0;
  error.url = details.url || '';
  error.body = details.body || '';
  return error;
}

export function isRujiraBaseFeeProviderRateLimit(error) {
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
        headers: {
          Accept: 'application/json',
          ...(config.providerClientId ? { 'x-client-id': config.providerClientId } : {})
        },
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
      if (isRujiraBaseFeeProviderRateLimit(error)) {
        throw error;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error(`Unable to fetch ${path}`);
}

export async function fetchRujiraBaseFeeRpcBlockResults(height) {
  return fetchJsonFromBases(config.rujiraBaseFeesRpcUrls, '/block_results', {
    height: String(height)
  });
}

export function parseRujiraBaseFeeRpcBatchResponse(payload, heights) {
  const entries = Array.isArray(payload)
    ? payload
    : heights.length === 1 && payload && typeof payload === 'object'
      ? [payload]
      : null;
  if (!entries) {
    throw createHttpError('Invalid JSON-RPC batch response: expected an array');
  }

  const responses = new Map(entries.map((entry) => [String(entry?.id || ''), entry]));
  return heights.map((value) => {
    const height = Math.max(1, Math.trunc(Number(value) || 1));
    const response = responses.get(String(height));
    if (!response) {
      return {
        height,
        error: createHttpError(`RPC batch response is missing height ${height}`)
      };
    }
    if (response.error || !response.result) {
      const message = response.error?.message || 'missing result';
      return {
        height,
        error: createHttpError(`RPC batch error for height ${height}: ${message}`, {
          body: JSON.stringify(response.error || {}).slice(0, 240)
        })
      };
    }
    return { height, payload: response };
  });
}

export async function fetchRujiraBaseFeeRpcBlockResultsBatch(heights) {
  const normalizedHeights = [...new Set(
    (Array.isArray(heights) ? heights : [])
      .map((height) => Math.max(0, Math.trunc(Number(height) || 0)))
      .filter((height) => height > 0)
  )];
  if (!normalizedHeights.length) return [];

  const requests = normalizedHeights.map((height) => ({
    jsonrpc: '2.0',
    id: String(height),
    method: 'block_results',
    params: { height: String(height) }
  }));
  let lastError = null;

  for (const base of config.rujiraBaseFeesRpcUrls) {
    const url = String(base || '').replace(/\/$/, '');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RPC_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(config.providerClientId ? { 'x-client-id': config.providerClientId } : {})
        },
        body: JSON.stringify(requests),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw createHttpError(
          `RPC batch error: ${response.status} ${response.statusText} for ${normalizedHeights.length} heights`,
          {
            status: response.status,
            url,
            body: text.slice(0, 240)
          }
        );
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw createHttpError(`Invalid JSON batch response from ${url}`, {
          url,
          body: text.slice(0, 240)
        });
      }
      return parseRujiraBaseFeeRpcBatchResponse(payload, normalizedHeights);
    } catch (error) {
      lastError = error;
      if (isRujiraBaseFeeProviderRateLimit(error)) throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error('Unable to fetch RPC block-results batch');
}

async function loadActionSyncState(client) {
  const { rows } = await client.query(
    `select sync_key, next_page_token, complete, rate_limited_until, updated_at, stats_json
     from rujira_base_fee_sync_state
     where sync_key = $1
     limit 1`,
    [ACTION_SYNC_KEY]
  );
  return rows[0] || null;
}

async function saveActionSyncState(client, payload) {
  await upsertRows(client, 'rujira_base_fee_sync_state', [
    {
      sync_key: ACTION_SYNC_KEY,
      next_page_token: payload.next_page_token || '',
      complete: Boolean(payload.complete),
      rate_limited_until: payload.rate_limited_until || null,
      updated_at: new Date().toISOString(),
      stats_json: payload.stats_json || {}
    }
  ], {
    conflictColumns: ['sync_key'],
    jsonColumns: ['stats_json']
  });
}

function isCooldownActive(syncState) {
  const untilMs = Date.parse(String(syncState?.rate_limited_until || ''));
  return Number.isFinite(untilMs) && untilMs > Date.now();
}

async function upsertActionsAndBlocks(client, actions) {
  const rows = actions
    .map(normalizeMidgardAction)
    .filter((row) => row.height > 0);
  if (!rows.length) {
    return {
      actions: 0,
      heights: 0
    };
  }

  await upsertRows(client, 'rujira_base_fee_actions', rows, {
    conflictColumns: ['action_key'],
    jsonColumns: ['raw_action']
  });

  const blockByHeight = new Map();
  for (const row of rows) {
    const existing = blockByHeight.get(row.height);
    if (!existing || String(row.action_date || '') < String(existing.block_time || '')) {
      blockByHeight.set(row.height, {
        height: row.height,
        block_time: row.action_date,
        updated_at: new Date().toISOString()
      });
    }
  }

  await upsertRows(client, 'rujira_base_fee_blocks', [...blockByHeight.values()], {
    columns: ['height', 'block_time', 'updated_at'],
    conflictColumns: ['height'],
    updateColumns: ['block_time', 'updated_at']
  });

  return {
    actions: rows.length,
    heights: blockByHeight.size
  };
}

async function loadKnownCoverageHeight(client) {
  const { rows } = await client.query(
    `select greatest(
              coalesce((select max(height) from rujira_base_fee_actions), 0),
              coalesce((select max(height) from rujira_base_fee_blocks where status = 'fetched'), 0),
              coalesce((select max(height) from rujira_base_fee_events), 0)
            )::bigint as max_height`
  );
  return Math.max(0, Number(rows[0]?.max_height) || 0);
}

function actionHeightRange(actions) {
  const heights = actions
    .map((action) => Number(action?.height) || 0)
    .filter((height) => height > 0);
  return {
    min: heights.length ? Math.min(...heights) : 0,
    max: heights.length ? Math.max(...heights) : 0
  };
}

export async function ingestRujiraBaseFeeActionPages(client, options = {}) {
  const syncState = await loadActionSyncState(client);
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
    ? 0
    : Math.max(0, Number(options.maxPages ?? config.rujiraBaseFeesMidgardMaxPages) || 0);
  const headMaxPages = Math.max(
    0,
    Number(options.headMaxPages ?? config.rujiraBaseFeesMidgardHeadMaxPages) || 0
  );
  const headLookbackBlocks = Math.max(
    1,
    Number(
      options.headLookbackBlocks ?? config.rujiraBaseFeesMidgardHeadLookbackBlocks
    ) || 1
  );
  const fetchPage = options.fetchPage || fetchRujiraSwapActionPage;
  const fetchForwardPage = options.fetchForwardPage || fetchRujiraSwapActionForwardPage;
  const sleepFn = options.sleepFn || sleep;
  const requestDelayMs = Math.max(
    0,
    Number(options.requestDelayMs ?? config.rujiraBaseFeesRequestDelayMs) || 0
  );
  const knownMaxHeight = await loadKnownCoverageHeight(client);
  // Midgard can traverse forward from a height with fromHeight/prevPageToken. Keep a
  // durable forward watermark that is independent of websocket-written max heights,
  // otherwise a listener restart can advance the DB tip past an unseen outage gap.
  const previousHeadCatchup = syncState?.stats_json?.head_catchup || {};
  const hasForwardState = previousHeadCatchup.direction === 'forward';
  const previousHeadCatchupToken = hasForwardState
    ? String(previousHeadCatchup.next_page_token || '')
    : '';
  const previousHeadWatermark = hasForwardState
    ? Math.max(0, Number(previousHeadCatchup.watermark_height) || 0)
    : 0;
  const previousHeadCatchupFloor = hasForwardState
    ? Math.max(0, Number(previousHeadCatchup.floor_height) || previousHeadWatermark)
    : Math.max(0, knownMaxHeight - headLookbackBlocks);
  const previousHeadCatchupMax = hasForwardState
    ? Math.max(previousHeadWatermark, Number(previousHeadCatchup.max_height) || 0)
    : previousHeadWatermark;
  const previousBackfill = syncState?.stats_json?.backfill || {};
  const previousBackfillRetryAt = Date.parse(String(previousBackfill.retry_after || ''));
  const stats = {
    pages: 0,
    actions: 0,
    heights: 0,
    head_refresh: {
      pages: 0,
      actions: 0,
      heights: 0,
      min_height: 0,
      max_height: 0
    },
    head_catchup: {
      direction: 'forward',
      pages: 0,
      actions: 0,
      heights: 0,
      min_height: 0,
      max_height: previousHeadCatchupMax,
      floor_height: previousHeadCatchupToken
        ? previousHeadCatchupFloor
        : previousHeadWatermark || previousHeadCatchupFloor,
      watermark_height: previousHeadWatermark,
      next_page_token: previousHeadCatchupToken,
      complete: false,
      error: ''
    },
    backfill: {
      pages: 0,
      actions: 0,
      heights: 0,
      min_height: 0,
      max_height: 0,
      reused_head_page: false,
      retry_after: Number.isFinite(previousBackfillRetryAt)
        ? new Date(previousBackfillRetryAt).toISOString()
        : '',
      error: '',
      skipped: ''
    },
    next_page_token: nextPageToken,
    complete
  };

  async function ingestPage(pageToken, bucket, pageFetcher = fetchPage) {
    if (stats.pages > 0 && requestDelayMs > 0) {
      await sleepFn(requestDelayMs);
    }
    const payload = await pageFetcher(pageToken);
    const actions = Array.isArray(payload?.actions) ? payload.actions : [];
    const inserted = await upsertActionsAndBlocks(client, actions);
    stats.pages += 1;
    stats.actions += inserted.actions;
    stats.heights += inserted.heights;
    bucket.pages += 1;
    bucket.actions += inserted.actions;
    bucket.heights += inserted.heights;
    const range = actionHeightRange(actions);
    if (range.min > 0) {
      bucket.min_height = bucket.min_height > 0
        ? Math.min(bucket.min_height, range.min)
        : range.min;
    }
    bucket.max_height = Math.max(bucket.max_height || 0, range.max);
    return {
      nextPageToken: String(payload?.meta?.nextPageToken || ''),
      payload,
      range,
      inserted
    };
  }

  let headCatchupToken = previousHeadCatchupToken;
  let headCatchupComplete = false;
  let headError = null;
  for (let page = 0; page < headMaxPages && !headCatchupComplete; page += 1) {
    try {
      const request = headCatchupToken
        ? { prevPageToken: headCatchupToken }
        : { fromHeight: stats.head_catchup.floor_height };
      const catchupPage = await ingestPage(request, stats.head_catchup, fetchForwardPage);
      if (page === 0) {
        stats.head_refresh = {
          pages: 1,
          actions: catchupPage.inserted.actions,
          heights: catchupPage.inserted.heights,
          min_height: catchupPage.range.min,
          max_height: catchupPage.range.max
        };
      }
      headCatchupToken = String(catchupPage.payload?.meta?.prevPageToken || '');
      headCatchupComplete = catchupPage.inserted.actions === 0 || !headCatchupToken;
      if (headCatchupComplete) headCatchupToken = '';
    } catch (error) {
      headError = error;
      stats.head_catchup.error = String(error?.message || error).slice(0, 500);
      break;
    }
  }

  stats.head_catchup.next_page_token = headCatchupToken;
  stats.head_catchup.complete = headCatchupComplete;
  if (headCatchupComplete) {
    stats.head_catchup.watermark_height = Math.max(
      previousHeadWatermark,
      stats.head_catchup.max_height
    );
  }

  // Persist head progress before touching the unrelated historical cursor. A slow
  // old Midgard page must not discard recent outage recovery or starve RPC blocks.
  await saveActionSyncState(client, {
    next_page_token: alreadyComplete ? '' : nextPageToken,
    complete,
    rate_limited_until: null,
    stats_json: {
      ...stats,
      next_page_token: alreadyComplete ? '' : nextPageToken,
      complete,
      mode: alreadyComplete ? 'head_refresh' : 'backfill'
    }
  });

  if (headError) {
    if (isRujiraBaseFeeProviderRateLimit(headError)) throw headError;
    return {
      ...stats,
      next_page_token: alreadyComplete ? '' : nextPageToken,
      complete,
      mode: alreadyComplete ? 'head_refresh' : 'backfill'
    };
  }

  if (headMaxPages > 0 && !headCatchupComplete) {
    stats.backfill.skipped = 'head_catchup_incomplete';
    return {
      ...stats,
      next_page_token: alreadyComplete ? '' : nextPageToken,
      complete,
      mode: alreadyComplete ? 'head_refresh' : 'backfill'
    };
  }

  const historicalRetryActive = Number.isFinite(previousBackfillRetryAt)
    && previousBackfillRetryAt > Date.now();
  if (!alreadyComplete && maxPages > 0 && historicalRetryActive) {
    stats.backfill.skipped = 'provider_retry_cooldown';
  }

  let backfillPage = 0;
  if (!alreadyComplete && maxPages > 0 && !historicalRetryActive && !nextPageToken) {
    try {
      const firstBackfillPage = await ingestPage('', stats.backfill);
      nextPageToken = firstBackfillPage.nextPageToken;
      complete = !nextPageToken;
      backfillPage = 1;
    } catch (error) {
      stats.backfill.error = String(error?.message || error).slice(0, 500);
      stats.backfill.retry_after = new Date(Date.now() + HISTORICAL_ACTION_RETRY_MS).toISOString();
      if (isRujiraBaseFeeProviderRateLimit(error)) throw error;
    }
  }

  if (!historicalRetryActive && !stats.backfill.error) {
    for (; backfillPage < maxPages && !complete; backfillPage += 1) {
      try {
        const backfillResult = await ingestPage(nextPageToken, stats.backfill);
        nextPageToken = backfillResult.nextPageToken;

        if (!nextPageToken) {
          complete = true;
          break;
        }
      } catch (error) {
        stats.backfill.error = String(error?.message || error).slice(0, 500);
        stats.backfill.retry_after = new Date(Date.now() + HISTORICAL_ACTION_RETRY_MS).toISOString();
        if (isRujiraBaseFeeProviderRateLimit(error)) throw error;
        break;
      }
    }
  }

  const mode = alreadyComplete ? 'head_refresh' : 'backfill';

  await saveActionSyncState(client, {
    next_page_token: alreadyComplete ? '' : nextPageToken,
    complete,
    rate_limited_until: null,
    stats_json: {
      ...stats,
      next_page_token: alreadyComplete ? '' : nextPageToken,
      complete,
      mode
    }
  });

  return {
    ...stats,
    next_page_token: alreadyComplete ? '' : nextPageToken,
    complete,
    mode
  };
}

async function putActionSyncCooldown(client, error) {
  const syncState = await loadActionSyncState(client);
  const until = new Date(Date.now() + config.rujiraBaseFeesRateLimitCooldownMs).toISOString();
  await saveActionSyncState(client, {
    next_page_token: syncState?.next_page_token || '',
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

async function loadPendingBlocks(client, limit) {
  const { rows } = await client.query(
    `select height, block_time, attempts
     from rujira_base_fee_blocks
     where status = 'pending'
        or (status = 'error' and next_retry_at <= now())
     order by height desc
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
    `update rujira_base_fee_blocks
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

const BASE_FEE_EVENT_COLUMNS = Object.freeze([
  'event_key',
  'canonical_key',
  'height',
  'block_time',
  'swap_id',
  'pool',
  'chain',
  'from_address',
  'to_address',
  'coin',
  'memo',
  'liquidity_fee_base',
  'liquidity_fee_rune',
  'rune_price_usd',
  'liquidity_fee_usd',
  'classification',
  'included',
  'source_contract',
  'source_label',
  'source_denom',
  'context_origin',
  'source',
  'source_provenance',
  'raw_event',
  'context_json',
  'updated_at'
]);

const BASE_FEE_EVENT_JSON_COLUMNS = new Set([
  'source_provenance',
  'raw_event',
  'context_json'
]);

function sourceForBaseFeeEvent(value) {
  return String(value || '').trim().toLowerCase() === 'dune' ? 'dune' : 'legacy';
}

function normalizeBaseFeeEventForStorage(event) {
  const source = sourceForBaseFeeEvent(event?.source);
  const originalEventKey = String(event?.event_key || '').trim();
  const identity = normalizeRujiraBaseFeeIdentity(event, source === 'legacy' ? `legacy:${originalEventKey}` : originalEventKey);
  if (!identity.canonical_key) {
    throw new Error('Rujira base-fee event is missing a canonical identity');
  }

  const sourceProvenance = event?.source_provenance && typeof event.source_provenance === 'object'
    && !Array.isArray(event.source_provenance)
    ? { ...event.source_provenance }
    : {};
  if (!sourceProvenance[source]) {
    sourceProvenance[source] = source === 'dune'
      ? makeDuneSourceProvenance(originalEventKey).dune
      : makeLegacySourceProvenance(event?.context_origin, originalEventKey).legacy;
  }

  const liquidityFeeBase = identity.liquidity_fee_base || '0';
  return {
    event_key: identity.canonical_key,
    canonical_key: identity.canonical_key,
    height: identity.height,
    block_time: event?.block_time || null,
    swap_id: identity.swap_id,
    pool: identity.pool,
    chain: identity.chain,
    from_address: identity.from_address,
    to_address: identity.to_address,
    coin: String(event?.coin || '').trim(),
    memo: identity.memo,
    liquidity_fee_base: liquidityFeeBase,
    liquidity_fee_rune: safeNumber(event?.liquidity_fee_rune, baseRuneToNumber(liquidityFeeBase)),
    rune_price_usd: safeNumber(event?.rune_price_usd, 0),
    liquidity_fee_usd: safeNumber(event?.liquidity_fee_usd, 0),
    classification: String(event?.classification || 'unknown').trim(),
    included: Boolean(event?.included),
    source_contract: String(event?.source_contract || '').trim().toLowerCase(),
    source_label: String(event?.source_label || event?.classification || '').trim(),
    source_denom: String(event?.source_denom || '').trim(),
    context_origin: String(event?.context_origin || '').trim(),
    source,
    source_provenance: sourceProvenance,
    raw_event: event?.raw_event || {},
    context_json: event?.context_json || {},
    updated_at: event?.updated_at || new Date().toISOString()
  };
}

function mergeBaseFeeEventRows(existing, incoming) {
  const incomingWins = incoming.source === 'dune' || existing.source !== 'dune';
  const preferred = incomingWins ? incoming : existing;
  const sourceProvenance = {
    ...(existing.source_provenance || {}),
    ...(incoming.source_provenance || {})
  };
  return {
    ...preferred,
    source: incomingWins ? incoming.source : existing.source,
    source_provenance: sourceProvenance
  };
}

function dedupeBaseFeeEventRows(events) {
  const byCanonicalKey = new Map();
  for (const event of events) {
    const existing = byCanonicalKey.get(event.canonical_key);
    byCanonicalKey.set(event.canonical_key, existing ? mergeBaseFeeEventRows(existing, event) : event);
  }
  return [...byCanonicalKey.values()];
}

function buildBaseFeeEventUpsertQuery(rows) {
  const values = [];
  const tuples = rows.map((row) => {
    const placeholders = BASE_FEE_EVENT_COLUMNS.map((column) => {
      const value = BASE_FEE_EVENT_JSON_COLUMNS.has(column)
        ? JSON.stringify(row[column] || {})
        : row[column];
      values.push(value);
      return BASE_FEE_EVENT_JSON_COLUMNS.has(column) ? `$${values.length}::jsonb` : `$${values.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  const preferIncoming = "(excluded.source = 'dune' or rujira_base_fee_events.source <> 'dune')";
  const preferred = (column) => `case when ${preferIncoming} then excluded.${column} else rujira_base_fee_events.${column} end`;

  return {
    text: `insert into rujira_base_fee_events (${BASE_FEE_EVENT_COLUMNS.join(', ')})
           values ${tuples.join(', ')}
           on conflict (canonical_key) do update
           set event_key = ${preferred('event_key')},
               height = excluded.height,
               block_time = case
                 when ${preferIncoming} then coalesce(excluded.block_time, rujira_base_fee_events.block_time)
                 else rujira_base_fee_events.block_time
               end,
               swap_id = ${preferred('swap_id')},
               pool = ${preferred('pool')},
               chain = ${preferred('chain')},
               from_address = ${preferred('from_address')},
               to_address = ${preferred('to_address')},
               coin = ${preferred('coin')},
               memo = ${preferred('memo')},
               liquidity_fee_base = ${preferred('liquidity_fee_base')},
               liquidity_fee_rune = ${preferred('liquidity_fee_rune')},
               rune_price_usd = ${preferred('rune_price_usd')},
               liquidity_fee_usd = ${preferred('liquidity_fee_usd')},
               classification = ${preferred('classification')},
               included = ${preferred('included')},
               source_contract = ${preferred('source_contract')},
               source_label = ${preferred('source_label')},
               source_denom = ${preferred('source_denom')},
               context_origin = ${preferred('context_origin')},
               source = ${preferred('source')},
               source_provenance = coalesce(rujira_base_fee_events.source_provenance, '{}'::jsonb)
                 || coalesce(excluded.source_provenance, '{}'::jsonb),
               raw_event = ${preferred('raw_event')},
               context_json = ${preferred('context_json')},
               updated_at = excluded.updated_at`,
    values
  };
}

export async function saveRujiraBaseFeeEvents(client, events) {
  if (!Array.isArray(events) || !events.length) {
    return 0;
  }

  const normalized = dedupeBaseFeeEventRows(events.map(normalizeBaseFeeEventForStorage));
  for (const chunk of chunkArray(normalized, 200)) {
    const statement = buildBaseFeeEventUpsertQuery(chunk);
    await client.query(statement.text, statement.values);
  }

  return normalized.length;
}

function rejectDuneBaseFeeEvent(reason) {
  return { row: null, reason };
}

function normalizeDuneRujiraBaseFeeEvent(row) {
  const sourceEventKey = String(row?.event_key || '').trim();
  const parsedBlockTime = parseUtcDateTime(row?.block_time);
  const identity = normalizeRujiraBaseFeeIdentity({
    height: row?.height,
    swap_id: row?.swap_id || row?.tx_id,
    pool: row?.pool,
    chain: row?.chain,
    from_address: row?.from_address,
    to_address: row?.to_address,
    memo: row?.memo,
    liquidity_fee_base: row?.liquidity_fee_base
  });
  const classification = String(row?.classification || '').trim().toLowerCase();
  const policy = DUNE_BASE_FEE_CLASSIFICATIONS[classification];
  const included = parseStrictBoolean(row?.included);
  const sourceContract = String(row?.source_contract || '').trim().toLowerCase();
  const source = String(row?.source || '').trim().toLowerCase();
  const coin = String(row?.coin || '').trim();

  if (!sourceEventKey) return rejectDuneBaseFeeEvent('missing event_key');
  if (!parsedBlockTime) return rejectDuneBaseFeeEvent('invalid block_time');
  if (!identity.height) return rejectDuneBaseFeeEvent('missing height');
  if (!/^[A-F0-9]{64}(?:-[0-9]+)?$/.test(identity.swap_id)) return rejectDuneBaseFeeEvent('invalid swap_id');
  if (!identity.pool || !identity.pool.includes('.')) return rejectDuneBaseFeeEvent('invalid pool');
  if (identity.chain !== 'THOR') return rejectDuneBaseFeeEvent('unexpected swap chain');
  if (identity.from_address !== RUJIRA_THORCHAIN_SWAP_CONTRACT) {
    return rejectDuneBaseFeeEvent('unexpected swap sender');
  }
  if (source && source !== 'dune') return rejectDuneBaseFeeEvent('unexpected source');
  if (!policy) return rejectDuneBaseFeeEvent('unsupported classification');
  if (included === null || included !== policy.included) {
    return rejectDuneBaseFeeEvent('classification/included mismatch');
  }
  if (policy.sourceContract && sourceContract !== policy.sourceContract) {
    return rejectDuneBaseFeeEvent('classification/source_contract mismatch');
  }
  if (policy.requireSourceContract && !sourceContract.startsWith('thor1')) {
    return rejectDuneBaseFeeEvent('missing source_contract');
  }
  const allowsMissingMemo = classification === 'direct_ruji_swap_excluded' && !included;
  if (!identity.to_address
    || (!identity.memo && !allowsMissingMemo)
    || identity.memo.startsWith('%%skipped%%')) {
    return rejectDuneBaseFeeEvent('missing swap destination or memo');
  }
  if (!coin) return rejectDuneBaseFeeEvent('missing swap coin');
  if (!identity.liquidity_fee_base) return rejectDuneBaseFeeEvent('invalid liquidity_fee_base');
  if (sourceContract === RUJI_SWAP_REVENUE_COLLECTOR && classification !== 'ruji_swap_revenue_excluded') {
    return rejectDuneBaseFeeEvent('RUJI Swap collector must be excluded');
  }
  if (sourceContract === RUJIRA_THORCHAIN_SWAP_CONTRACT && classification !== 'direct_ruji_swap_excluded') {
    return rejectDuneBaseFeeEvent('direct RUJI Swap path must be excluded');
  }
  if (sourceContract === BASE_LAYER_REVENUE_COLLECTOR && classification !== 'base_collector_conversion') {
    return rejectDuneBaseFeeEvent('Base Layer collector classification mismatch');
  }
  if (!isFiniteNonNegativeNumber(row?.liquidity_fee_rune)
    || !isFiniteNonNegativeNumber(row?.rune_price_usd)
    || !isFiniteNonNegativeNumber(row?.liquidity_fee_usd)) {
    return rejectDuneBaseFeeEvent('invalid fee or price value');
  }

  const liquidityFeeRune = baseRuneToNumber(identity.liquidity_fee_base);
  const runePriceUsd = Number(row.rune_price_usd);
  const liquidityFeeUsd = liquidityFeeRune * runePriceUsd;
  if (!closeEnough(row.liquidity_fee_rune, liquidityFeeRune)) {
    return rejectDuneBaseFeeEvent('liquidity_fee_rune does not match base amount');
  }
  if (!closeEnough(row.liquidity_fee_usd, liquidityFeeUsd)) {
    return rejectDuneBaseFeeEvent('liquidity_fee_usd does not match RUNE/USD price');
  }

  return {
    row: {
      event_key: identity.canonical_key,
      canonical_key: identity.canonical_key,
      height: identity.height,
      block_time: toIsoString(parsedBlockTime),
      swap_id: identity.swap_id,
      pool: identity.pool,
      chain: identity.chain,
      from_address: identity.from_address,
      to_address: identity.to_address,
      coin,
      memo: identity.memo,
      liquidity_fee_base: identity.liquidity_fee_base,
      liquidity_fee_rune: liquidityFeeRune,
      rune_price_usd: runePriceUsd,
      liquidity_fee_usd: liquidityFeeUsd,
      classification,
      included,
      source_contract: sourceContract,
      source_label: sourceLabelForClassification(classification, sourceContract),
      source_denom: String(row?.source_denom || '').trim(),
      context_origin: 'dune-wasm-tx',
      source: 'dune',
      source_provenance: makeDuneSourceProvenance(sourceEventKey),
      raw_event: {
        source: 'dune',
        query_id: config.rujiraBaseFeesDuneQueryId,
        source_event_key: sourceEventKey,
        row
      },
      context_json: {
        source: 'dune',
        query_id: config.rujiraBaseFeesDuneQueryId,
        source_event_key: sourceEventKey,
        classification,
        included,
        source_contract: sourceContract,
        source_label: sourceLabelForClassification(classification, sourceContract),
        source_denom: String(row?.source_denom || '').trim()
      },
      updated_at: new Date().toISOString()
    },
    reason: ''
  };
}

function duneRowsAgree(left, right) {
  return [
    'height',
    'block_time',
    'swap_id',
    'pool',
    'chain',
    'from_address',
    'to_address',
    'coin',
    'memo',
    'liquidity_fee_base',
    'liquidity_fee_rune',
    'rune_price_usd',
    'liquidity_fee_usd',
    'classification',
    'included',
    'source_contract',
    'source_denom'
  ].every((key) => left[key] === right[key]);
}

function mergeDuplicateDuneRows(existing, incoming) {
  const sourceEventKeys = new Set([
    ...(existing.source_provenance?.dune?.source_event_keys || []),
    ...(incoming.source_provenance?.dune?.source_event_keys || [])
  ]);
  existing.source_provenance.dune.source_event_keys = [...sourceEventKeys].sort();
  return existing;
}

function normalizeDuneRujiraBaseFeeRows(rows = []) {
  const accepted = new Map();
  const rejected = [];

  for (const rawRow of Array.isArray(rows) ? rows : []) {
    const normalized = normalizeDuneRujiraBaseFeeEvent(rawRow);
    if (!normalized.row) {
      rejected.push({ reason: normalized.reason, row: rawRow });
      continue;
    }

    const existing = accepted.get(normalized.row.canonical_key);
    if (existing && !duneRowsAgree(existing, normalized.row)) {
      rejected.push({ reason: 'conflicting duplicate canonical event', row: rawRow });
      continue;
    }
    accepted.set(normalized.row.canonical_key, existing
      ? mergeDuplicateDuneRows(existing, normalized.row)
      : normalized.row);
  }

  return {
    rows: [...accepted.values()],
    rejected
  };
}

export function buildRujiraBaseFeeRowsFromDune(rows = []) {
  return normalizeDuneRujiraBaseFeeRows(rows).rows;
}

async function upsertRujiraBaseFeeDuneBlocks(client, rows, executionId) {
  const byHeight = new Map();
  for (const row of rows) {
    const existing = byHeight.get(row.height);
    if (!existing || String(row.block_time || '') < String(existing.block_time || '')) {
      byHeight.set(row.height, {
        height: row.height,
        block_time: row.block_time,
        status: 'fetched',
        attempts: 0,
        next_retry_at: new Date().toISOString(),
        error: '',
        scan_json: {
          source: 'dune',
          dune_query_id: config.rujiraBaseFeesDuneQueryId,
          dune_execution_id: executionId,
          event_count: rows.filter((candidate) => candidate.height === row.height).length
        },
        fetched_at: new Date().toISOString(),
        parsed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }
  }

  await upsertRows(client, 'rujira_base_fee_blocks', [...byHeight.values()], {
    columns: [
      'height',
      'block_time',
      'status',
      'attempts',
      'next_retry_at',
      'error',
      'scan_json',
      'fetched_at',
      'parsed_at',
      'updated_at'
    ],
    conflictColumns: ['height'],
    updateColumns: [
      'block_time',
      'status',
      'attempts',
      'next_retry_at',
      'error',
      'scan_json',
      'fetched_at',
      'parsed_at',
      'updated_at'
    ],
    jsonColumns: ['scan_json']
  });

  return byHeight.size;
}

export async function markRujiraBaseFeeBlockFetched(client, height, payload = {}) {
  await client.query(
    `insert into rujira_base_fee_blocks (
       height, block_time, status, attempts, next_retry_at, error,
       scan_json, fetched_at, parsed_at, updated_at
     )
     values ($1, $2, 'fetched', $3, now(), '', $4::jsonb, now(), now(), now())
     on conflict (height) do update
     set block_time = coalesce(excluded.block_time, rujira_base_fee_blocks.block_time),
         status = 'fetched',
         attempts = greatest(rujira_base_fee_blocks.attempts, excluded.attempts),
         next_retry_at = now(),
         error = '',
         scan_json = excluded.scan_json,
         fetched_at = now(),
         parsed_at = now(),
         updated_at = now()`,
    [
      Number(height),
      payload.block_time || null,
      Math.max(0, Number(payload.attempts) || 0),
      JSON.stringify(payload.scan_json || {})
    ]
  );
}

export async function saveParsedRujiraBaseFeeBlock(client, height, blockPayload, options = {}) {
  const blockHeight = Number(height);
  const parsed = options.parsed || parseRujiraBaseFeeBlock(blockHeight, blockPayload, {
    blockTime: options.blockTime || null
  });

  if (!parsed.events.length && !options.persistEmpty) {
    return parsed;
  }

  await client.query(
    `delete from rujira_base_fee_events
     where height = $1
       and source = 'legacy'`,
    [blockHeight]
  );
  if (parsed.events.length) {
    await saveRujiraBaseFeeEvents(client, parsed.events);
  }

  await markRujiraBaseFeeBlockFetched(client, blockHeight, {
    block_time: parsed.events[0]?.block_time || options.blockTime || null,
    attempts: options.attempts || 0,
    scan_json: {
      ...parsed.scan,
      source: options.source || 'rpc',
      rpc_height: blockPayload?.result?.height || String(blockHeight)
    }
  });

  return parsed;
}

async function saveParsedBlock(client, row, blockPayload, parsed) {
  return saveParsedRujiraBaseFeeBlock(client, Number(row.height), blockPayload, {
    parsed,
    blockTime: row.block_time ? new Date(row.block_time).toISOString() : null,
    source: 'backfill',
    attempts: Number(row.attempts || 0) + 1,
    persistEmpty: true
  });
}

export async function processRujiraBaseFeeBlockHeight(client, height, options = {}) {
  const blockHeight = Number(height);
  const payload = await fetchRujiraBaseFeeRpcBlockResults(blockHeight);
  return saveParsedRujiraBaseFeeBlock(client, blockHeight, payload, {
    blockTime: options.blockTime || null,
    source: options.source || 'rpc',
    attempts: options.attempts || 0,
    persistEmpty: Boolean(options.persistEmpty)
  });
}

export async function processRujiraBaseFeeBlocks(client, options = {}) {
  const limit = Math.max(0, Number(options.limit ?? config.rujiraBaseFeesBlockMaxHeights) || 0);
  if (limit <= 0) {
    return {
      selected: 0,
      fetched: 0,
      errored: 0,
      events: 0,
      included_events: 0,
      excluded_events: 0
    };
  }

  const blocks = await loadPendingBlocks(client, limit);
  const batchSize = Math.max(
    1,
    Math.trunc(Number(options.batchSize ?? config.rujiraBaseFeesRpcBatchSize) || 1)
  );
  const fetchBatch = options.fetchBatch || fetchRujiraBaseFeeRpcBlockResultsBatch;
  const stats = {
    selected: blocks.length,
    batches: 0,
    fetched: 0,
    errored: 0,
    events: 0,
    included_events: 0,
    excluded_events: 0
  };

  const batches = chunkArray(blocks, batchSize);
  for (const [batchIndex, batch] of batches.entries()) {
    let results;
    try {
      results = await fetchBatch(batch.map((row) => Number(row.height)));
      stats.batches += 1;
    } catch (error) {
      if (isRujiraBaseFeeProviderRateLimit(error)) {
        await putActionSyncCooldown(client, error);
        throw error;
      }
      for (const row of batch) {
        await markBlockError(client, row, error);
        stats.errored += 1;
      }
      results = [];
    }

    const byHeight = new Map(results.map((entry) => [Number(entry.height), entry]));
    for (const row of batch) {
      const result = byHeight.get(Number(row.height));
      if (!result || result.error) {
        if (result?.error) {
          await markBlockError(client, row, result.error);
          stats.errored += 1;
        }
        continue;
      }

      try {
        const parsed = parseRujiraBaseFeeBlock(Number(row.height), result.payload, {
          blockTime: row.block_time ? new Date(row.block_time).toISOString() : null
        });
        await saveParsedBlock(client, row, result.payload, parsed);
        stats.fetched += 1;
        stats.events += parsed.events.length;
        stats.included_events += parsed.events.filter((event) => event.included).length;
        stats.excluded_events += parsed.events.filter((event) => !event.included).length;
      } catch (error) {
        await markBlockError(client, row, error);
        stats.errored += 1;
      }
    }

    if (batchIndex < batches.length - 1 && config.rujiraBaseFeesRequestDelayMs > 0) {
      await sleep(config.rujiraBaseFeesRequestDelayMs);
    }
  }

  return stats;
}

async function fetchRunePriceWeeks(fromTs, count) {
  const params = new URLSearchParams({
    interval: 'week',
    from: String(fromTs),
    count: String(Math.max(1, Math.min(400, count)))
  });
  const payload = await fetchMidgard(`/history/rune?${params.toString()}`, {
    bases: config.rujiraBaseFeesMidgardUrls,
    validateResponse: (_path, data) => !Array.isArray(data?.intervals)
  });

  return payload.intervals.map((row) => ({
    week_start: dateKey(new Date(Number(row.startTime) * 1000)),
    week_end: dateKey(new Date(Number(row.endTime) * 1000)),
    rune_price_usd: Number(row.runePriceUSD) || 0,
    source_json: row
  }));
}

export async function refreshRujiraBaseFeePrices(client) {
  const { rows } = await client.query(
    `select min(block_time) as min_time, max(block_time) as max_time
     from rujira_base_fee_events
     where block_time is not null
       and included = true
       and rune_price_usd = 0`
  );
  const minTime = rows[0]?.min_time;
  const maxTime = rows[0]?.max_time;
  if (!minTime || !maxTime) {
    return {
      weeks: 0,
      priced_events: 0
    };
  }

  const firstWeek = startOfUtcWeek(minTime);
  const lastWeek = startOfUtcWeek(maxTime);
  const weekCount = Math.ceil((lastWeek.getTime() - firstWeek.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 2;
  const priceRows = await fetchRunePriceWeeks(Math.floor(firstWeek.getTime() / 1000), weekCount);
  await upsertRows(client, 'rujira_base_fee_rune_price_weeks', priceRows, {
    conflictColumns: ['week_start'],
    jsonColumns: ['source_json']
  });

  const updateResult = await client.query(
    `update rujira_base_fee_events event
     set rune_price_usd = price.rune_price_usd,
         liquidity_fee_usd = event.liquidity_fee_rune * price.rune_price_usd,
         updated_at = now()
     from rujira_base_fee_rune_price_weeks price
     where event.block_time is not null
       and event.rune_price_usd = 0
       and date_trunc('week', event.block_time at time zone 'UTC')::date = price.week_start`
  );

  return {
    weeks: priceRows.length,
    priced_events: Number(updateResult.rowCount) || 0
  };
}

function normalizeWeeklyRows(rows) {
  let cumulativeRune = 0;
  let cumulativeUsd = 0;
  return rows.map((row) => {
    const liquidityFeeRune = Number(row.liquidity_fee_rune) || 0;
    const liquidityFeeUsd = Number(row.liquidity_fee_usd) || 0;
    cumulativeRune += liquidityFeeRune;
    cumulativeUsd += liquidityFeeUsd;
    const weekStart = dateKey(row.week_start);
    return {
      week_start: weekStart,
      week_end: dateKey(addDays(new Date(`${weekStart}T00:00:00.000Z`), 7)),
      swap_events: Number(row.swap_events) || 0,
      active_heights: Number(row.active_heights) || 0,
      liquidity_fee_rune: roundNumber(liquidityFeeRune, 8),
      rune_price_usd: Number(row.rune_price_usd) || 0,
      liquidity_fee_usd: roundNumber(liquidityFeeUsd, 8),
      cumulative_rune: roundNumber(cumulativeRune, 8),
      cumulative_usd: roundNumber(cumulativeUsd, 8)
    };
  });
}

function normalizeDailyRows(rows) {
  let cumulativeRune = 0;
  let cumulativeUsd = 0;
  return rows.map((row) => {
    const liquidityFeeRune = Number(row.liquidity_fee_rune) || 0;
    const liquidityFeeUsd = Number(row.liquidity_fee_usd) || 0;
    cumulativeRune += liquidityFeeRune;
    cumulativeUsd += liquidityFeeUsd;
    const dayStart = dateKey(row.day_start);
    return {
      day_start: dayStart,
      day_end: dateKey(addDays(new Date(`${dayStart}T00:00:00.000Z`), 1)),
      swap_events: Number(row.swap_events) || 0,
      active_heights: Number(row.active_heights) || 0,
      liquidity_fee_rune: roundNumber(liquidityFeeRune, 8),
      rune_price_usd: Number(row.rune_price_usd) || 0,
      liquidity_fee_usd: roundNumber(liquidityFeeUsd, 8),
      cumulative_rune: roundNumber(cumulativeRune, 8),
      cumulative_usd: roundNumber(cumulativeUsd, 8)
    };
  });
}

function normalizeAggregateRows(rows) {
  return rows.map((row) => ({
    classification: String(row.classification || ''),
    included: Boolean(row.included),
    source_denom: String(row.source_denom || ''),
    source_contract: String(row.source_contract || ''),
    source_label: String(row.source_label || row.classification || ''),
    pool: String(row.pool || ''),
    swap_events: Number(row.swap_events) || 0,
    active_heights: Number(row.active_heights) || 0,
    liquidity_fee_rune: roundNumber(row.liquidity_fee_rune, 8),
    liquidity_fee_usd: roundNumber(row.liquidity_fee_usd, 8)
  }));
}

function resolveBaseFeeSourceProvider(eventSources, syncStats = {}) {
  const sources = new Set(
    (Array.isArray(eventSources) ? eventSources : [])
      .map((source) => String(source || '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (sources.has('dune') && sources.has('legacy')) return 'mixed';
  if (sources.has('dune')) return 'dune';
  if (sources.has('legacy')) return 'legacy';
  return String(syncStats.source || '') === 'dune'
    && !/^missing_dune_/i.test(String(syncStats.reason || ''))
    ? 'dune'
    : 'legacy';
}

async function fetchDashboardStats(client) {
  const [actions, blocks, events, sync, listener] = await Promise.all([
    client.query(
      `select count(*)::bigint as count,
              min(height)::bigint as min_height,
              max(height)::bigint as max_height
       from rujira_base_fee_actions`
    ),
    client.query(
      `select status, count(*)::bigint as count
       from rujira_base_fee_blocks
       group by status`
    ),
    client.query(
      `select count(*)::bigint as total_events,
              count(*) filter (where included)::bigint as included_events,
              count(*) filter (where not included)::bigint as excluded_events,
              count(distinct height) filter (where included)::bigint as active_heights,
              coalesce(sum(liquidity_fee_rune) filter (where included), 0) as included_fee_rune,
              coalesce(sum(liquidity_fee_usd) filter (where included), 0) as included_fee_usd,
              coalesce(array_agg(distinct source) filter (where source is not null), array[]::text[]) as source_providers,
              max(updated_at) as updated_at
       from rujira_base_fee_events`
    ),
    client.query(
      `select next_page_token, complete, rate_limited_until, updated_at, stats_json
       from rujira_base_fee_sync_state
       where sync_key = $1
       limit 1`,
      [ACTION_SYNC_KEY]
    ),
    client.query(
      `select finished_at, status, stats_json
       from rujira_base_fee_job_runs
       where job_name = 'rujira-base-fees-ws-listener'
       order by finished_at desc nulls last, started_at desc
       limit 1`
    )
  ]);

  return {
    actions: actions.rows[0] || {},
    blockCounts: Object.fromEntries(blocks.rows.map((row) => [row.status, Number(row.count) || 0])),
    events: events.rows[0] || {},
    sync: sync.rows[0] || null,
    listener: listener.rows[0] || null
  };
}

export async function getRujiraBaseFeesDashboardPayload(client = { query }) {
  const [weeklyResult, dailyResult, routesResult, poolsResult, excludedResult, recentResult, stats] = await Promise.all([
    client.query(
      `select date_trunc('week', block_time at time zone 'UTC')::date as week_start,
              count(*)::bigint as swap_events,
              count(distinct height)::bigint as active_heights,
              coalesce(sum(liquidity_fee_rune), 0) as liquidity_fee_rune,
              coalesce(sum(liquidity_fee_usd), 0) as liquidity_fee_usd,
              coalesce(avg(nullif(rune_price_usd, 0)), 0) as rune_price_usd
       from rujira_base_fee_events
       where included = true
         and block_time is not null
       group by 1
       order by 1 asc`
    ),
    client.query(
      `select date_trunc('day', block_time at time zone 'UTC')::date as day_start,
              count(*)::bigint as swap_events,
              count(distinct height)::bigint as active_heights,
              coalesce(sum(liquidity_fee_rune), 0) as liquidity_fee_rune,
              coalesce(sum(liquidity_fee_usd), 0) as liquidity_fee_usd,
              coalesce(avg(nullif(rune_price_usd, 0)), 0) as rune_price_usd
       from rujira_base_fee_events
       where included = true
         and block_time is not null
       group by 1
       order by 1 asc`
    ),
    client.query(
      `select classification, included, source_denom, source_contract, source_label,
              count(*)::bigint as swap_events,
              count(distinct height)::bigint as active_heights,
              coalesce(sum(liquidity_fee_rune), 0) as liquidity_fee_rune,
              coalesce(sum(liquidity_fee_usd), 0) as liquidity_fee_usd
       from rujira_base_fee_events
       where included = true
       group by classification, included, source_denom, source_contract, source_label
       order by liquidity_fee_usd desc`
    ),
    client.query(
      `select pool,
              count(*)::bigint as swap_events,
              count(distinct height)::bigint as active_heights,
              coalesce(sum(liquidity_fee_rune), 0) as liquidity_fee_rune,
              coalesce(sum(liquidity_fee_usd), 0) as liquidity_fee_usd
       from rujira_base_fee_events
       where included = true
       group by pool
       order by liquidity_fee_usd desc`
    ),
    client.query(
      `select classification, included, source_denom, source_contract, source_label,
              count(*)::bigint as swap_events,
              count(distinct height)::bigint as active_heights,
              coalesce(sum(liquidity_fee_rune), 0) as liquidity_fee_rune,
              coalesce(sum(liquidity_fee_usd), 0) as liquidity_fee_usd
       from rujira_base_fee_events
       where included = false
       group by classification, included, source_denom, source_contract, source_label
       order by liquidity_fee_usd desc`
    ),
    client.query(
      `select event_key, height, block_time, swap_id, pool, coin, memo,
              liquidity_fee_rune, liquidity_fee_usd, classification,
              source_contract, source_label, source_denom, source
       from rujira_base_fee_events
       where included = true
       order by block_time desc nulls last, height desc
       limit 50`
    ),
    fetchDashboardStats(client)
  ]);

  const weekly = normalizeWeeklyRows(weeklyResult.rows);
  const daily = normalizeDailyRows(dailyResult.rows);
  const routes = normalizeAggregateRows(routesResult.rows);
  const pools = normalizeAggregateRows(poolsResult.rows);
  const excluded = normalizeAggregateRows(excludedResult.rows);
  const totalFeeRune = Number(stats.events.included_fee_rune) || 0;
  const totalFeeUsd = Number(stats.events.included_fee_usd) || 0;
  const blockCounts = stats.blockCounts || {};
  const sync = stats.sync || {};
  const duneStats = sync?.stats_json || {};
  const sourceProvider = resolveBaseFeeSourceProvider(stats.events.source_providers, duneStats);
  const usesDune = sourceProvider === 'dune' || sourceProvider === 'mixed';

  return {
    schema_version: 2,
    meta: {
      generatedAt: new Date().toISOString(),
      source: sourceProvider === 'dune'
        ? 'dune-query-backed-postgres'
        : sourceProvider === 'mixed'
          ? 'mixed-dune-and-legacy-postgres'
          : 'boonetools-postgres',
      sourceProviders: Array.isArray(stats.events.source_providers)
        ? stats.events.source_providers
        : [],
      scope: 'DB-backed Rujira app-layer THORChain swap fees, excluding direct/RUJI Swap collector contexts.',
      method:
        sourceProvider === 'dune'
          ? 'Execute the BooneTools Rujira Base Fees Dune source query over thorchain.core_wasm_contracts_events and thorchain.defi_swaps, classify Rujira app context by WASM event type, and upsert generated base-layer swap-fee rows into the local dashboard cache.'
          : sourceProvider === 'mixed'
            ? 'Use validated Dune rows where available and the legacy THORNode RPC/Midgard parser for fallback or live rows. Canonical swap identities prevent the overlapping sources from being counted twice.'
          : 'Listen to THORChain NewBlock websocket events for steady-state heights, independently page the current Midgard head with a durable catch-up cursor, fetch candidate block_results payloads by RPC, match Rujira-emitted swap memos to final THORNode swap events, and sum liquidity_fee_in_rune for non-RUJI-Swap app contexts. Historical Midgard paging retains its own backfill cursor.',
      caveat:
        'This tracks base-layer liquidity fees generated by app-layer activity. It is separate from explicit Reserve revenue-share deposits and intentionally keeps excluded RUJI Swap/direct contexts out of the headline total.',
      rujiraThorchainSwapContract: RUJIRA_THORCHAIN_SWAP_CONTRACT,
      excludedRujiSwapRevenueCollector: RUJI_SWAP_REVENUE_COLLECTOR,
      actionCount: Number(stats.actions.count) || 0,
      actionMinHeight: Number(stats.actions.min_height) || 0,
      actionMaxHeight: Number(stats.actions.max_height) || 0,
      blockCount: Object.values(blockCounts).reduce((sum, count) => sum + count, 0),
      pendingBlockCount: blockCounts.pending || 0,
      fetchedBlockCount: blockCounts.fetched || 0,
      errorBlockCount: blockCounts.error || 0,
      backfillComplete: Boolean(sync.complete),
      nextPageToken: sync.next_page_token || '',
      headCatchup: sync.stats_json?.head_catchup
        ? {
            direction: String(sync.stats_json.head_catchup.direction || ''),
            complete: Boolean(sync.stats_json.head_catchup.complete),
            floorHeight: Number(sync.stats_json.head_catchup.floor_height) || 0,
            watermarkHeight: Number(sync.stats_json.head_catchup.watermark_height) || 0,
            minHeight: Number(sync.stats_json.head_catchup.min_height) || 0,
            maxHeight: Number(sync.stats_json.head_catchup.max_height) || 0,
            pages: Number(sync.stats_json.head_catchup.pages) || 0,
            nextPageToken: String(sync.stats_json.head_catchup.next_page_token || ''),
            error: String(sync.stats_json.head_catchup.error || '')
          }
        : null,
      rateLimitedUntil: toIsoString(sync.rate_limited_until),
      duneQueryId: usesDune ? sync.stats_json?.dune_query_id || config.rujiraBaseFeesDuneQueryId : '',
      duneExecutionId: usesDune ? sync.stats_json?.dune_execution_id || '' : '',
      duneNextStartTime: usesDune ? sync.stats_json?.dune_next_start_time || '' : '',
      matchedSwapFeeEventCount: Number(stats.events.included_events) || 0,
      excludedSwapFeeEventCount: Number(stats.events.excluded_events) || 0,
      activeHeightCount: Number(stats.events.active_heights) || 0,
      totalLiquidityFeeRune: roundNumber(totalFeeRune, 8),
      totalLiquidityFeeUsd: roundNumber(totalFeeUsd, 8),
      updatedAt: toIsoString(stats.events.updated_at || sync.updated_at),
      wsListener: stats.listener
        ? {
            status: stats.listener.status || '',
            lastHeartbeat: toIsoString(stats.listener.finished_at),
            stats: stats.listener.stats_json || {}
          }
        : null
    },
    weekly,
    daily,
    routes,
    pools,
    excluded,
    recent_events: recentResult.rows.map((row) => ({
      event_key: String(row.event_key || ''),
      height: Number(row.height) || 0,
      block_time: toIsoString(row.block_time),
      swap_id: String(row.swap_id || ''),
      pool: String(row.pool || ''),
      coin: String(row.coin || ''),
      memo: String(row.memo || ''),
      liquidity_fee_rune: roundNumber(row.liquidity_fee_rune, 8),
      liquidity_fee_usd: roundNumber(row.liquidity_fee_usd, 8),
      classification: String(row.classification || ''),
      source_contract: String(row.source_contract || ''),
      source_label: String(row.source_label || ''),
      source_denom: String(row.source_denom || ''),
      source: String(row.source || '')
    }))
  };
}

export async function writeRujiraBaseFeeListenerHeartbeat(payload = {}) {
  await upsertRows({ query }, 'rujira_base_fee_job_runs', [{
    id: '00000000-0000-0000-0000-000000000013',
    job_name: 'rujira-base-fees-ws-listener',
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

export async function runRujiraBaseFeesDuneIngestion(client) {
  if (!config.duneApiKey || !config.rujiraBaseFeesDuneQueryId) {
    await saveActionSyncState(client, {
      next_page_token: '',
      complete: false,
      rate_limited_until: null,
      stats_json: {
        source: 'dune',
        skipped: true,
        reason: !config.duneApiKey ? 'missing_dune_api_key' : 'missing_dune_rujira_base_fees_query_id',
        dune_query_id: config.rujiraBaseFeesDuneQueryId
      }
    });
    return {
      skipped: true,
      reason: !config.duneApiKey ? 'missing_dune_api_key' : 'missing_dune_rujira_base_fees_query_id',
      source: 'dune',
      upserted: 0
    };
  }

  const syncState = await loadActionSyncState(client);
  const previousStats = syncState?.stats_json || {};
  const configuredStart = parseUtcDateTime(config.rujiraBaseFeesDuneStartTime) || new Date('2026-04-30T00:00:00.000Z');
  const startTime = parseUtcDateTime(previousStats.dune_next_start_time) || configuredStart;
  const headEndTime = addHours(new Date(), -Math.max(0, config.rujiraBaseFeesDuneHeadLagHours));

  if (startTime >= headEndTime) {
    await saveActionSyncState(client, {
      next_page_token: '',
      complete: true,
      rate_limited_until: null,
      stats_json: {
        ...previousStats,
        source: 'dune',
        skipped: true,
        reason: 'caught_up_to_dune_head_lag',
        dune_query_id: config.rujiraBaseFeesDuneQueryId,
        dune_next_start_time: formatDuneDateTime(startTime),
        dune_head_lag_hours: config.rujiraBaseFeesDuneHeadLagHours
      }
    });
    return {
      skipped: true,
      reason: 'caught_up_to_dune_head_lag',
      source: 'dune',
      upserted: 0
    };
  }

  const windowEnd = new Date(Math.min(
    addDays(startTime, Math.max(1, config.rujiraBaseFeesDuneDaysPerRun)).getTime(),
    headEndTime.getTime()
  ));
  const limit = Math.max(1, Math.trunc(Number(config.rujiraBaseFeesDuneLimit) || 5000));
  const result = await executeDuneQueryRows(config.rujiraBaseFeesDuneQueryId, {
    start_time: formatDuneDateTime(startTime),
    end_time: formatDuneDateTime(windowEnd),
    limit
  }, {
    limit
  });
  const normalizedDuneRows = normalizeDuneRujiraBaseFeeRows(result.rows);
  if (normalizedDuneRows.rejected.length) {
    const reasons = [...new Set(normalizedDuneRows.rejected.map((entry) => entry.reason))];
    throw new Error(
      `Dune generated-fee validation rejected ${normalizedDuneRows.rejected.length} row(s): ${reasons.join(', ')}`
    );
  }
  const rows = normalizedDuneRows.rows;

  if (rows.length) {
    await saveRujiraBaseFeeEvents(client, rows);
  }
  const heights = rows.length ? await upsertRujiraBaseFeeDuneBlocks(client, rows, result.executionId) : 0;
  const lastBlockTime = rows
    .map((row) => parseUtcDateTime(row.block_time))
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const hitLimit = result.rows.length >= limit;
  const nextStartTime = hitLimit && lastBlockTime ? lastBlockTime : windowEnd;

  await saveActionSyncState(client, {
    next_page_token: '',
    complete: nextStartTime >= headEndTime,
    rate_limited_until: null,
    stats_json: {
      source: 'dune',
      dune_query_id: config.rujiraBaseFeesDuneQueryId,
      dune_execution_id: result.executionId,
      start_time: formatDuneDateTime(startTime),
      end_time: formatDuneDateTime(windowEnd),
      dune_next_start_time: formatDuneDateTime(nextStartTime),
      rows: result.rows.length,
      accepted_rows: rows.length,
      duplicate_rows_collapsed: result.rows.length - rows.length,
      upserted: rows.length,
      heights,
      included_events: rows.filter((row) => row.included).length,
      excluded_events: rows.filter((row) => !row.included).length,
      hit_limit: hitLimit
    }
  });

  return {
    source: 'dune',
    dune_query_id: config.rujiraBaseFeesDuneQueryId,
    dune_execution_id: result.executionId,
    start_time: formatDuneDateTime(startTime),
    end_time: formatDuneDateTime(windowEnd),
    rows: result.rows.length,
    accepted_rows: rows.length,
    duplicate_rows_collapsed: result.rows.length - rows.length,
    upserted: rows.length,
    heights,
    next_start_time: formatDuneDateTime(nextStartTime),
    hit_limit: hitLimit
  };
}

async function runRujiraBaseFeesLegacyIngestion(client, initialStats = {}) {
  const stats = {
    ...initialStats,
    action_scan: null,
    block_scan: null,
    pricing: null,
    provider_cooldown: Boolean(initialStats.provider_cooldown)
  };

  try {
    stats.action_scan = await ingestRujiraBaseFeeActionPages(client);
  } catch (error) {
    if (!isRujiraBaseFeeProviderRateLimit(error)) {
      throw error;
    }
    stats.provider_cooldown = true;
    stats.action_scan = {
      error: error.message,
      rate_limited_until: await putActionSyncCooldown(client, error)
    };
  }

  try {
    stats.block_scan = await processRujiraBaseFeeBlocks(client);
  } catch (error) {
    if (!isRujiraBaseFeeProviderRateLimit(error)) {
      throw error;
    }
    stats.provider_cooldown = true;
    stats.block_scan = {
      error: error.message,
      rate_limited_until: await putActionSyncCooldown(client, error)
    };
  }

  stats.pricing = await refreshRujiraBaseFeePrices(client);

  return stats;
}

export async function runRujiraBaseFeesIngestion(client) {
  if (config.rujiraBaseFeesDuneQueryId) {
    try {
      const duneSource = await runRujiraBaseFeesDuneIngestion(client);
      if (!duneSource?.skipped) {
        return {
          dune_source: duneSource,
          pricing: {
            skipped: true,
            reason: 'dune_rows_include_usd_prices'
          },
          provider_cooldown: false
        };
      }

      return runRujiraBaseFeesLegacyIngestion(client, {
        dune_source: duneSource,
        fallback_source: 'legacy',
        fallback_reason: duneSource.reason || 'dune_skipped'
      });
    } catch (error) {
      const duneError = summarizeDuneError(error);
      return runRujiraBaseFeesLegacyIngestion(client, {
        dune_source: {
          source: 'dune',
          status: 'error',
          dune_query_id: config.rujiraBaseFeesDuneQueryId,
          error: duneError
        },
        fallback_source: 'legacy',
        fallback_reason: 'dune_error'
      });
    }
  }

  return runRujiraBaseFeesLegacyIngestion(client);
}
