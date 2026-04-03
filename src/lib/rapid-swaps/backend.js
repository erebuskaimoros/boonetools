import {
  buildAssetUsdIndex,
  normalizeRapidSwapAction
} from './model.js';
import {
  isPlausibleRapidSwapRowMatch,
  normalizeRapidSwapHint,
  pickBestRapidSwapRowMatch
} from './reconciliation.js';

export const MIDGARD_BASES = [
  'https://midgard.thorchain.network/v2',
  'https://midgard.ninerealms.com/v2',
  'https://midgard.liquify.com/v2'
];

export const THORNODE_BASES = [
  'https://thornode.thorchain.network',
  'https://thornode.ninerealms.com'
];

export const ACTION_PAGE_LIMIT = 50;
export const DIRECT_RESOLUTION_HEIGHT_BUFFER = 40;
export const RECENT_SCAN_HEIGHT_BUFFER = 80;

let activeMidgardIndex = 0;
let activeThornodeIndex = 0;

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isChallengeResponse(response) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const cfMitigated = response.headers.get('cf-mitigated');
  return contentType.includes('text/html') || Boolean(cfMitigated);
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

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'x-client-id': 'RuneTools',
      ...headers
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  if (isChallengeResponse(response)) {
    throw new Error(`Challenge response for ${url}`);
  }

  return response.json();
}

async function fetchWithFallback(bases, path, options = {}) {
  const { startIndex = 0, headers = {}, validatePayload = null } = options;
  let lastError = null;

  for (let i = 0; i < bases.length; i += 1) {
    const idx = (startIndex + i) % bases.length;
    try {
      const payload = await fetchJson(`${bases[idx]}${path}`, headers);
      if (typeof validatePayload === 'function' && validatePayload(path, payload)) {
        throw new Error(`Invalid payload for ${bases[idx]}${path}`);
      }
      return { payload, index: idx };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`All endpoints failed for ${path}`);
}

export async function fetchThorchain(endpoint) {
  const result = await fetchWithFallback(THORNODE_BASES, endpoint, {
    startIndex: activeThornodeIndex
  });
  activeThornodeIndex = result.index;
  return result.payload;
}

export async function fetchThorchainTx(txId) {
  if (!txId) {
    return null;
  }

  return fetchThorchain(`/thorchain/tx/${encodeURIComponent(String(txId))}`);
}

export async function fetchRapidSwapPriceIndex() {
  const [network, pools] = await Promise.all([
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

  const result = await fetchWithFallback(MIDGARD_BASES, `/actions?${params.toString()}`, {
    startIndex: activeMidgardIndex,
    validatePayload: isMidgardPayloadInvalid
  });
  activeMidgardIndex = result.index;

  return {
    actions: Array.isArray(result.payload?.actions) ? result.payload.actions : [],
    nextPageToken: String(result.payload?.meta?.nextPageToken || '')
  };
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
