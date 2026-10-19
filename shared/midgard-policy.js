// Runtime-neutral response checks. A true result asks the transport to try the
// next configured provider; it does not alter request filters or pagination.
export const MIDGARD_ACTION_PAGE_LIMIT = 50;

// Rapid scans intentionally accept empty history without a positive time span
// and enforce action-filter/cursor evidence in addition to the general checks.
export const RAPID_MIDGARD_VALIDATION_OPTIONS = Object.freeze({
  emptyHistory: 'nonzero-range',
  normalizeActionLimit: true,
  checkActionFilters: true
});

function searchParams(path) {
  try {
    return new URL(path, 'https://midgard.invalid').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function actionContainsTxId(action, txId) {
  const target = String(txId).toUpperCase();
  return [action?.in, action?.out].some((transactions) => (
    Array.isArray(transactions)
      && transactions.some((transaction) => String(transaction?.txID || '').toUpperCase() === target)
  ));
}

export function isMidgardPayloadInvalid(path, payload, {
  emptyHistory = 'metadata',
  normalizeActionLimit = false,
  checkActionFilters = false
} = {}) {
  const params = searchParams(path);

  if (path.startsWith('/history/') && params.has('interval')) {
    if (!Array.isArray(payload?.intervals) || payload.intervals.length !== 0) return false;
    return emptyHistory === 'nonzero-range'
      ? finiteNumber(payload?.meta?.endTime) > finiteNumber(payload?.meta?.startTime)
      : Boolean(payload?.meta);
  }

  if (!path.startsWith('/actions')) return false;

  const actions = Array.isArray(payload?.actions) ? payload.actions : [];
  const requestedLimit = normalizeActionLimit
    ? Math.max(1, Math.trunc(finiteNumber(params.get('limit'), MIDGARD_ACTION_PAGE_LIMIT)))
    : Number(params.get('limit'));
  if (
    (normalizeActionLimit || params.has('limit'))
    && Number.isFinite(requestedLimit)
    && requestedLimit > 0
    && requestedLimit < MIDGARD_ACTION_PAGE_LIMIT
    && actions.length > requestedLimit
  ) return true;

  if (!checkActionFilters) return false;

  const requestedTxId = String(params.get('txid') || '');
  if (requestedTxId && actions.length > 0 && !actions.some((action) => actionContainsTxId(action, requestedTxId))) {
    return true;
  }

  const requestedNextPageToken = String(params.get('nextPageToken') || '');
  if (requestedNextPageToken && String(payload?.meta?.nextPageToken || '') === requestedNextPageToken) {
    return true;
  }

  const requestedFromHeight = Math.max(0, Math.trunc(finiteNumber(params.get('fromHeight'))));
  if (requestedFromHeight > 0 && actions.length > 0) {
    const highestReturnedHeight = actions.reduce(
      (maxHeight, action) => Math.max(maxHeight, Math.max(0, Math.trunc(finiteNumber(action?.height)))),
      0
    );
    if (highestReturnedHeight < requestedFromHeight) return true;
  }

  return false;
}
