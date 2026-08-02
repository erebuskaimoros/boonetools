import {
  buildAssetUsdIndex,
  buildRapidSwapSyntheticAction,
  midgardTimestampToMillis,
  normalizeRapidSwapAction,
  normalizeRapidSwapHintAction
} from './model.js';
import {
  isPlausibleRapidSwapRowMatch,
  normalizeRapidSwapHint,
  pickBestRapidSwapRowMatch
} from './reconciliation.js';
import { ProviderRequestError, requestFromProviders } from '../provider-client.js';

let providerLifecycle = {};

export function configureRapidSwapProviderLifecycle(hooks = {}) {
  providerLifecycle = hooks && typeof hooks === 'object' ? hooks : {};
}

function readEnv(name) {
  return typeof process !== 'undefined' ? String(process.env?.[name] || '').trim() : '';
}

function uniqueBases(values) {
  return [...new Set(values.map((value) => String(value || '').replace(/\/$/, '')).filter(Boolean))];
}

function envBases(name) {
  return readEnv(name).split(',').map((value) => value.trim()).filter(Boolean);
}

const configuredMidgardBases = envBases('MIDGARD_URLS');
export const MIDGARD_BASES = uniqueBases(configuredMidgardBases.length
  ? configuredMidgardBases
  : [
      readEnv('MIDGARD_URL') || 'https://gateway.liquify.com/chain/thorchain_midgard/v2'
    ]);

const configuredThornodeBases = envBases('THORNODE_URLS');
export const THORNODE_BASES = uniqueBases(configuredThornodeBases.length
  ? configuredThornodeBases
  : [
      readEnv('THORNODE_PRIMARY_URL') || 'https://gateway.liquify.com/chain/thorchain_api'
    ]);

export const ACTION_PAGE_LIMIT = 50;
export const DIRECT_RESOLUTION_HEIGHT_BUFFER = 40;
export const RECENT_SCAN_HEIGHT_BUFFER = 80;

export class RapidSwapProviderError extends ProviderRequestError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'RapidSwapProviderError';
  }
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function safeString(value) {
  return String(value || '').trim();
}

function safeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function coreSnapshotStale(snapshot, requiredFields = []) {
  const payload = snapshot?.payload || snapshot;
  if (!payload || snapshot?.stale || payload.stale) return true;
  if (!payload.field_meta) return false;
  return requiredFields.some((key) => {
    const status = payload.field_meta[key]?.status;
    return !Object.prototype.hasOwnProperty.call(payload, key)
      || status === 'reused'
      || status === 'error';
  });
}

function getSearchParams(path) {
  try {
    return new URL(path, MIDGARD_BASES[0]).searchParams;
  } catch (_) {
    return new URLSearchParams();
  }
}

function actionContainsTxId(action, txId) {
  if (!txId) {
    return false;
  }

  const target = String(txId).toUpperCase();
  const inTxIds = Array.isArray(action?.in) ? action.in.map((item) => String(item?.txID || '').toUpperCase()) : [];
  const outTxIds = Array.isArray(action?.out) ? action.out.map((item) => String(item?.txID || '').toUpperCase()) : [];
  return [...inTxIds, ...outTxIds].includes(target);
}

function isMidgardPayloadInvalid(path, payload) {
  const params = getSearchParams(path);

  if (path.startsWith('/history/') && params.has('interval')) {
    const intervals = Array.isArray(payload?.intervals) ? payload.intervals : null;
    const metaStart = safeNumber(payload?.meta?.startTime, 0);
    const metaEnd = safeNumber(payload?.meta?.endTime, 0);
    if (intervals && intervals.length === 0 && metaEnd > metaStart) {
      return true;
    }
  }

  if (!path.startsWith('/actions')) {
    return false;
  }

  const actions = Array.isArray(payload?.actions) ? payload.actions : [];
  const requestedLimit = Math.max(1, Math.trunc(safeNumber(params.get('limit'), ACTION_PAGE_LIMIT)));
  if (requestedLimit < ACTION_PAGE_LIMIT && actions.length > requestedLimit) {
    return true;
  }

  const requestedTxId = String(params.get('txid') || '');
  if (requestedTxId && actions.length > 0 && !actions.some((action) => actionContainsTxId(action, requestedTxId))) {
    return true;
  }

  const requestedNextPageToken = String(params.get('nextPageToken') || '');
  if (requestedNextPageToken && String(payload?.meta?.nextPageToken || '') === requestedNextPageToken) {
    return true;
  }

  const requestedFromHeight = Math.max(0, Math.trunc(safeNumber(params.get('fromHeight'), 0)));
  if (requestedFromHeight > 0 && actions.length > 0) {
    const highestReturnedHeight = actions.reduce(
      (maxHeight, action) => Math.max(maxHeight, Math.max(0, Math.trunc(safeNumber(action?.height, 0)))),
      0
    );
    if (highestReturnedHeight < requestedFromHeight) {
      return true;
    }
  }

  return false;
}

export function isRapidSwapRateLimitError(error) {
  return Boolean(
    error?.status === 429 ||
    /HTTP 429|Too Many Requests|daily request limit|rate.?limit|rune pouch is empty/i.test(String(error?.message || '')) ||
    /daily request limit|rate.?limit|rune pouch is empty/i.test(String(error?.body || ''))
  );
}

export function getRapidSwapRateLimitCooldownMs(error, fallbackMs = 60 * 60 * 1000) {
  if (!isRapidSwapRateLimitError(error)) {
    return 0;
  }

  const retryAfterMs = Math.max(0, Math.trunc(safeNumber(error?.retryAfterSeconds, 0))) * 1000;
  const baseCooldownMs = Math.max(60 * 1000, Math.trunc(safeNumber(fallbackMs, 60 * 60 * 1000)));

  return Math.max(baseCooldownMs, retryAfterMs);
}

async function fetchWithFallback(bases, path, options = {}) {
  const { startIndex = 0, headers = {}, validatePayload = null } = options;
  const orderedBases = bases.map((_, offset) => bases[(startIndex + offset) % bases.length]);
  const payload = await requestFromProviders({
    bases: orderedBases,
    path,
    timeoutMs: 10_000,
    headers: {
      Accept: 'application/json',
      'x-client-id': readEnv('BOONETOOLS_PROVIDER_CLIENT_ID') || 'BooneTools',
      ...headers
    },
    validateResponse: typeof validatePayload === 'function'
      ? (value) => validatePayload(path, value)
        ? `Invalid payload for ${path}`
        : null
      : null,
    ...providerLifecycle,
    shouldStop: (error) => !error?.skipProvider && isRapidSwapRateLimitError(error)
  });
  return { payload, index: startIndex };
}

export async function fetchThorchain(endpoint) {
  return (await fetchWithFallback(THORNODE_BASES, endpoint)).payload;
}

export async function fetchThorchainTx(txId) {
  if (!txId) {
    return null;
  }

  return fetchThorchain(`/thorchain/tx/${encodeURIComponent(String(txId))}`);
}

export async function fetchRapidSwapPriceIndex(options = {}) {
  const core = options.coreSnapshot?.payload || options.coreSnapshot || null;
  if (core && coreSnapshotStale(options.coreSnapshot, ['network', 'pools'])) {
    throw new Error('Durable THORNode core snapshot is stale');
  }
  const [network, pools] = core
    ? [core.network, core.pools]
    : await Promise.all([
        fetchThorchain('/thorchain/network'),
        fetchThorchain('/thorchain/pools')
      ]);

  return buildAssetUsdIndex(network, Array.isArray(pools) ? pools : []);
}

export async function fetchMidgardActions(options = {}) {
  const params = new URLSearchParams({
    type: 'swap',
    limit: String(Math.max(1, Math.trunc(options.limit || ACTION_PAGE_LIMIT)))
  });

  if (options.nextPageToken) {
    params.set('nextPageToken', String(options.nextPageToken));
  } else if (!options.txId && !options.address && !options.fromHeight && !options.timestamp && !options.fromTimestamp) {
    params.set('offset', String(Math.max(0, Math.trunc(safeNumber(options.offset, 0)))));
  }

  if (options.txId) {
    params.set('txid', String(options.txId));
  }

  if (options.address) {
    params.set('address', String(options.address));
  }

  if (options.fromHeight) {
    params.set('fromHeight', String(Math.max(0, Math.trunc(options.fromHeight))));
  }

  if (options.timestamp) {
    params.set('timestamp', String(Math.max(0, Math.trunc(options.timestamp))));
  }

  if (options.fromTimestamp) {
    params.set('fromTimestamp', String(Math.max(0, Math.trunc(options.fromTimestamp))));
  }

  const bases = Array.isArray(options.bases) && options.bases.length
    ? uniqueBases(options.bases)
    : MIDGARD_BASES;
  const result = await fetchWithFallback(bases, `/actions?${params.toString()}`, {
    startIndex: 0,
    validatePayload: isMidgardPayloadInvalid
  });

  return {
    actions: Array.isArray(result.payload?.actions) ? result.payload.actions : [],
    nextPageToken: String(result.payload?.meta?.nextPageToken || '')
  };
}

function normalizeLatestSwapAction(action) {
  if (!action || typeof action !== 'object') {
    return null;
  }

  const dateMs = midgardTimestampToMillis(action.date);
  const txId = safeString(action?.in?.[0]?.txID || action?.txID);

  return {
    height: Math.max(0, Math.trunc(safeNumber(action.height, 0))),
    date: dateMs > 0 ? new Date(dateMs).toISOString() : '',
    status: safeString(action.status),
    source_asset: safeString(action?.in?.[0]?.coins?.[0]?.asset),
    target_asset: safeString(action?.out?.[0]?.coins?.[0]?.asset),
    tx_id: txId
  };
}

function pickHaltFlags(mimir = {}) {
  const entries = Object.entries(mimir && typeof mimir === 'object' ? mimir : {});
  const haltFlags = {};
  for (const [key, value] of entries) {
    if (/^HALT|TRADING|SIGNING/.test(key)) {
      haltFlags[key] = safeNumber(value, 0);
    }
  }

  return haltFlags;
}

function summarizeLastblock(lastblock = []) {
  const rows = Array.isArray(lastblock) ? lastblock : [];
  const thorchainHeights = rows.map((row) => safeNumber(row?.thorchain, 0)).filter((value) => value > 0);
  const signedHeights = rows.map((row) => safeNumber(row?.last_signed_out, 0)).filter((value) => value > 0);

  return {
    chain_count: rows.length,
    thorchain_height: thorchainHeights.length ? Math.max(...thorchainHeights) : 0,
    min_last_signed_out: signedHeights.length ? Math.min(...signedHeights) : 0,
    max_last_signed_out: signedHeights.length ? Math.max(...signedHeights) : 0
  };
}

function summarizeInbound(inboundAddresses = []) {
  const rows = Array.isArray(inboundAddresses) ? inboundAddresses : [];
  const tradableRows = rows.filter((row) => safeString(row?.chain));
  const pausedRows = tradableRows.filter((row) => (
    safeBoolean(row?.halted) ||
    safeBoolean(row?.global_trading_paused) ||
    safeBoolean(row?.chain_trading_paused)
  ));

  return {
    chain_count: tradableRows.length,
    paused_chain_count: pausedRows.length,
    all_trading_paused: tradableRows.length > 0 && pausedRows.length === tradableRows.length,
    sample: tradableRows.slice(0, 12).map((row) => ({
      chain: safeString(row.chain),
      halted: safeBoolean(row.halted),
      global_trading_paused: safeBoolean(row.global_trading_paused),
      chain_trading_paused: safeBoolean(row.chain_trading_paused),
      chain_lp_actions_paused: safeBoolean(row.chain_lp_actions_paused)
    }))
  };
}

function settledValue(result, fallback) {
  return result?.status === 'fulfilled' ? result.value : fallback;
}

function settledError(result) {
  return result?.status === 'rejected'
    ? safeString(result.reason?.message || result.reason)
    : '';
}

export function classifyRapidSwapSourceStatus(parts = {}) {
  const mimir = parts.mimir && typeof parts.mimir === 'object' ? parts.mimir : {};
  const haltFlags = pickHaltFlags(mimir);
  const inbound = summarizeInbound(parts.inboundAddresses);
  const lastblock = summarizeLastblock(parts.lastblock);
  const latestSwapAction = normalizeLatestSwapAction(parts.latestSwapAction);
  const fetchErrors = Object.fromEntries(
    Object.entries(parts.errors || {}).filter(([, value]) => safeString(value))
  );

  const globalTradingHalted = safeNumber(mimir.HALTTRADING, 0) > 0;
  const globalSigningHalted = safeNumber(mimir.HALTSIGNING, 0) > 0;
  const chainTradingFlags = Object.entries(haltFlags)
    .filter(([key]) => /^HALT.+TRADING$/.test(key) && key !== 'HALTTRADING')
    .map(([, value]) => safeNumber(value, 0));
  const chainSigningFlags = Object.entries(haltFlags)
    .filter(([key]) => /^HALTSIGNING.+/.test(key))
    .map(([, value]) => safeNumber(value, 0));
  const allChainTradingHalted = chainTradingFlags.length > 0 && chainTradingFlags.every((value) => value > 0);
  const allChainSigningHalted = chainSigningFlags.length > 0 && chainSigningFlags.every((value) => value > 0);
  const halted = globalTradingHalted ||
    globalSigningHalted ||
    allChainTradingHalted ||
    allChainSigningHalted ||
    inbound.all_trading_paused;

  const midgardStatus = parts.midgardRateLimited
    ? 'rate_limited'
    : fetchErrors.midgard
      ? 'error'
      : latestSwapAction
        ? 'ok'
        : 'empty';

  return {
    status: halted ? 'halted_idle' : fetchErrors.thornode || fetchErrors.midgard ? 'degraded' : 'active',
    observed_at: parts.observedAt || new Date().toISOString(),
    halted,
    trading_halted: globalTradingHalted || allChainTradingHalted || inbound.all_trading_paused,
    signing_halted: globalSigningHalted || allChainSigningHalted,
    halt_flags: haltFlags,
    inbound,
    lastblock,
    midgard: {
      status: midgardStatus,
      latest_swap_action: latestSwapAction,
      error: fetchErrors.midgard || ''
    },
    thornode: {
      status: fetchErrors.thornode ? 'error' : 'ok',
      error: fetchErrors.thornode || ''
    }
  };
}

export async function fetchRapidSwapSourceStatus(options = {}) {
  const observedAt = new Date().toISOString();
  const core = options.coreSnapshot?.payload || options.coreSnapshot || null;
  const coreStale = core
    ? coreSnapshotStale(options.coreSnapshot, ['mimir', 'inbound_addresses', 'lastblock'])
    : false;
  const midgardResult = (await Promise.allSettled([fetchMidgardActions({ limit: 1 })]))[0];
  const [mimirResult, inboundResult, lastblockResult] = core
    ? [
        { status: 'fulfilled', value: core.mimir || {} },
        { status: 'fulfilled', value: core.inbound_addresses || [] },
        { status: 'fulfilled', value: core.lastblock || [] }
      ]
    : await Promise.allSettled([
        fetchThorchain('/thorchain/mimir'),
        fetchThorchain('/thorchain/inbound_addresses'),
        fetchThorchain('/thorchain/lastblock')
      ]);

  const midgardError = settledError(midgardResult);
  const thornodeErrors = [
    settledError(mimirResult),
    settledError(inboundResult),
    settledError(lastblockResult)
  ].filter(Boolean);

  return classifyRapidSwapSourceStatus({
    observedAt,
    mimir: settledValue(mimirResult, {}),
    inboundAddresses: settledValue(inboundResult, []),
    lastblock: settledValue(lastblockResult, []),
    latestSwapAction: settledValue(midgardResult, { actions: [] })?.actions?.[0] || null,
    midgardRateLimited: midgardResult.status === 'rejected' && isRapidSwapRateLimitError(midgardResult.reason),
    errors: {
      thornode: coreStale
        ? 'Durable THORNode core snapshot is stale'
        : thornodeErrors.join('; '),
      midgard: midgardError
    }
  });
}

export async function enrichRapidSwapHint(hintInput = {}) {
  const hint = normalizeRapidSwapHint(hintInput);
  if (!hint.tx_id) {
    return hint;
  }

  const observedTx = await fetchThorchainTx(hint.tx_id).catch(() => null);
  if (!observedTx) {
    return hint;
  }

  const tx = observedTx?.observed_tx?.tx || {};

  return normalizeRapidSwapHint({
    ...hint,
    memo: hint.memo || String(tx.memo || ''),
    source_address: hint.source_address || String(tx.from_address || ''),
    observed_height: hint.observed_height || Math.max(0, Math.trunc(safeNumber(observedTx?.consensus_height, 0))),
    raw_hint: {
      ...hint.raw_hint,
      observed_tx: observedTx
    }
  });
}

function normalizeActionsToRows(actions, { observedAt, priceIndex }) {
  return (Array.isArray(actions) ? actions : [])
    .map((action) => normalizeRapidSwapAction(action, { observedAt, priceIndex }))
    .filter(Boolean);
}

export async function resolveRapidSwapHint(hintInput = {}, options = {}) {
  const observedAt = options.observedAt || new Date().toISOString();
  const priceIndex = options.priceIndex || await fetchRapidSwapPriceIndex();
  const allowMidgardLookup = Boolean(options.allowMidgardLookup);
  const addressSearchWindowBlocks = Math.max(
    1,
    Math.trunc(options.addressSearchWindowBlocks || DIRECT_RESOLUTION_HEIGHT_BUFFER)
  );
  const recentScanHeightBuffer = Math.max(
    1,
    Math.trunc(options.recentScanHeightBuffer || RECENT_SCAN_HEIGHT_BUFFER)
  );
  const recentScanMaxPages = Math.max(1, Math.trunc(options.recentScanMaxPages || 6));

  const hint = await enrichRapidSwapHint(hintInput);
  const syntheticAction = buildRapidSwapSyntheticAction(hint, hint?.raw_hint?.observed_tx || null, {
    observedAt
  });
  const directRow = normalizeRapidSwapHintAction(hint, hint?.raw_hint?.observed_tx || null, {
    observedAt,
    priceIndex
  });
  if (directRow) {
    return { row: directRow, hint, resolvedBy: 'thornode_tx' };
  }
  if (syntheticAction) {
    return {
      row: null,
      hint,
      resolvedBy: 'not_rapid',
      terminal: true,
      error: new Error('Direct THORNode reconciliation shows this swap is not rapid')
    };
  }

  if (!allowMidgardLookup) {
    return { row: null, hint, resolvedBy: '' };
  }

  if (hint.tx_id) {
    const directPayload = await fetchMidgardActions({
      txId: hint.tx_id,
      limit: 5
    }).catch(() => null);

    const directRows = normalizeActionsToRows(directPayload?.actions, { observedAt, priceIndex });
    const directMatch = pickBestRapidSwapRowMatch(directRows, hint) || directRows[0] || null;
    if (directMatch) {
      return { row: directMatch, hint, resolvedBy: 'tx_id' };
    }
  }

  if (hint.source_address) {
    const addressPayload = await fetchMidgardActions({
      address: hint.source_address,
      fromHeight: Math.max(0, hint.observed_height - addressSearchWindowBlocks),
      limit: 50
    }).catch(() => null);

    const addressRows = normalizeActionsToRows(addressPayload?.actions, { observedAt, priceIndex });
    const addressMatch = pickBestRapidSwapRowMatch(addressRows, hint);
    if (isPlausibleRapidSwapRowMatch(addressMatch, hint)) {
      return { row: addressMatch, hint, resolvedBy: 'address' };
    }
  }

  if (hint.observed_height > 0 || hint.memo || hint.source_address) {
    const recentScan = await fetchRapidSwapRows({
      maxPages: recentScanMaxPages,
      stopBelowHeight: hint.observed_height > 0
        ? Math.max(0, hint.observed_height - recentScanHeightBuffer)
        : 0,
      observedAt,
      priceIndex
    });

    const recentMatch = pickBestRapidSwapRowMatch(recentScan.rows, hint);
    if (isPlausibleRapidSwapRowMatch(recentMatch, hint)) {
      return { row: recentMatch, hint, resolvedBy: 'recent_scan' };
    }
  }

  return { row: null, hint, resolvedBy: '' };
}

export async function fetchRapidSwapRows(options = {}) {
  const maxPages = Math.max(1, Math.trunc(options.maxPages || 200));
  const knownTxIds = options.knownTxIds || null;
  const observedAt = options.observedAt || new Date().toISOString();
  const priceIndex = options.priceIndex || await fetchRapidSwapPriceIndex();
  const stopBelowHeight = Math.max(0, Math.trunc(options.stopBelowHeight || 0));

  const rowsByTxId = new Map();

  let nextPageToken = String(options.nextPageToken || '');
  let scannedPages = 0;
  let scannedActions = 0;
  let stoppedEarly = false;
  let reachedStopHeight = false;
  let consecutiveKnownPages = 0;
  let highestHeight = 0;
  let lowestHeight = Number.POSITIVE_INFINITY;
  let continuationToken = '';

  for (let page = 0; page < maxPages; page += 1) {
    const payload = await fetchMidgardActions({
      nextPageToken,
      limit: ACTION_PAGE_LIMIT
    });
    const actions = payload.actions || [];

    scannedPages += 1;
    scannedActions += actions.length;

    let foundNewOnPage = false;
    let foundAnyRapidOnPage = false;
    let pageLowestHeight = Number.POSITIVE_INFINITY;

    for (const action of actions) {
      const actionHeight = Math.max(0, Math.trunc(safeNumber(action?.height, 0)));
      if (actionHeight > 0) {
        highestHeight = Math.max(highestHeight, actionHeight);
        lowestHeight = Math.min(lowestHeight, actionHeight);
        pageLowestHeight = Math.min(pageLowestHeight, actionHeight);
      }

      const row = normalizeRapidSwapAction(action, {
        observedAt,
        priceIndex
      });

      if (row?.tx_id) {
        const txId = String(row.tx_id);
        foundAnyRapidOnPage = true;
        if (knownTxIds && !knownTxIds.has(txId)) {
          foundNewOnPage = true;
        }
        rowsByTxId.set(txId, row);
      }
    }

    if (stopBelowHeight > 0 && Number.isFinite(pageLowestHeight) && pageLowestHeight <= stopBelowHeight) {
      reachedStopHeight = true;
      continuationToken = '';
      break;
    }

    if (knownTxIds && foundAnyRapidOnPage) {
      if (!foundNewOnPage) {
        consecutiveKnownPages += 1;
      } else {
        consecutiveKnownPages = 0;
      }

      if (consecutiveKnownPages >= 3) {
        stoppedEarly = true;
        continuationToken = String(payload.nextPageToken || '');
        break;
      }
    }

    if (!payload.nextPageToken) {
      continuationToken = '';
      break;
    }

    nextPageToken = payload.nextPageToken;
    continuationToken = nextPageToken;
  }

  return {
    rows: [...rowsByTxId.values()],
    scannedPages,
    scannedActions,
    observedAt,
    stoppedEarly,
    reachedStopHeight,
    highestHeight,
    lowestHeight: Number.isFinite(lowestHeight) ? lowestHeight : 0,
    nextPageToken: continuationToken
  };
}
