import { midgardTimestampToMillis } from './model.js';

function safeString(value) {
  return String(value || '').trim();
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeHeight(value) {
  return Math.max(0, Math.trunc(safeNumber(value, 0)));
}

export const RAPID_SWAP_CANDIDATE_STATUS = Object.freeze({
  PENDING: 'pending',
  RESOLVED: 'resolved',
  ERROR: 'error'
});

export function buildRapidSwapHintKey(hint = {}) {
  const txId = safeString(hint.tx_id).toLowerCase();
  if (txId) {
    return `tx:${txId}`;
  }

  return [
    'hint',
    safeString(hint.source_address).toLowerCase(),
    safeString(hint.memo),
    normalizeHeight(hint.observed_height),
    normalizeHeight(hint.last_height),
    safeString(hint.deposit),
    safeString(hint.in),
    safeString(hint.out)
  ].join('|');
}

export function normalizeRapidSwapHint(hint = {}) {
  const normalized = {
    source: safeString(hint.source) || 'ws',
    tx_id: safeString(hint.tx_id),
    memo: safeString(hint.memo),
    source_address: safeString(hint.source_address),
    observed_height: normalizeHeight(hint.observed_height),
    last_height: normalizeHeight(hint.last_height),
    deposit: safeString(hint.deposit),
    in: safeString(hint.in),
    out: safeString(hint.out),
    status: safeString(hint.status) || RAPID_SWAP_CANDIDATE_STATUS.PENDING,
    attempts: Math.max(0, Math.trunc(safeNumber(hint.attempts, 0))),
    raw_hint: hint?.raw_hint && typeof hint.raw_hint === 'object'
      ? hint.raw_hint
      : {}
  };

  normalized.hint_key = safeString(hint.hint_key) || buildRapidSwapHintKey(normalized);
  return normalized;
}

function getRowHeight(row) {
  return normalizeHeight(row?.action_height || row?.raw_action?.height);
}

function getRowLastHeight(row) {
  return normalizeHeight(row?.raw_action?.metadata?.swap?.streamingSwapMeta?.lastHeight);
}

function getRowTimestamp(row) {
  return midgardTimestampToMillis(row?.action_date);
}

export function scoreRapidSwapRowMatch(row, hintInput = {}) {
  const hint = normalizeRapidSwapHint(hintInput);
  let score = 0;

  if (hint.tx_id && safeString(row?.tx_id).toLowerCase() === hint.tx_id.toLowerCase()) {
    score += 1000;
  }

  if (hint.memo && safeString(row?.memo) === hint.memo) {
    score += 400;
  }

  if (
    hint.source_address &&
    safeString(row?.source_address).toLowerCase() === hint.source_address.toLowerCase()
  ) {
    score += 250;
  }

  const rowHeight = getRowHeight(row);
  if (hint.observed_height > 0 && rowHeight > 0) {
    const diff = Math.abs(rowHeight - hint.observed_height);
    if (diff === 0) {
      score += 120;
    } else if (diff <= 3) {
      score += 105 - diff * 10;
    } else if (diff <= 20) {
      score += 60 - diff;
    }
  }

  const rowLastHeight = getRowLastHeight(row);
  if (hint.last_height > 0 && rowLastHeight > 0) {
    const diff = Math.abs(rowLastHeight - hint.last_height);
    if (diff === 0) {
      score += 90;
    } else if (diff <= 3) {
      score += 60 - diff * 10;
    }
  }

  return score;
}

export function pickBestRapidSwapRowMatch(rows, hintInput = {}) {
  const hint = normalizeRapidSwapHint(hintInput);
  let bestRow = null;
  let bestScore = 0;
  let bestHeightDiff = Number.POSITIVE_INFINITY;
  let bestTimestamp = -Infinity;

  for (const row of Array.isArray(rows) ? rows : []) {
    const score = scoreRapidSwapRowMatch(row, hint);
    if (score <= 0) {
      continue;
    }

    const rowHeight = getRowHeight(row);
    const heightDiff = hint.observed_height > 0 && rowHeight > 0
      ? Math.abs(rowHeight - hint.observed_height)
      : Number.POSITIVE_INFINITY;
    const timestamp = getRowTimestamp(row);

    if (
      !bestRow ||
      score > bestScore ||
      (score === bestScore && heightDiff < bestHeightDiff) ||
      (score === bestScore && heightDiff === bestHeightDiff && timestamp > bestTimestamp)
    ) {
      bestRow = row;
      bestScore = score;
      bestHeightDiff = heightDiff;
      bestTimestamp = timestamp;
    }
  }

  return bestRow;
}
