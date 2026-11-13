import { booneToolsApi } from '../api/boonetools.js';

export const STABLE_SWAPS_HISTORY_DAYS = 400;

// Matches the affiliate tab's timeframe labels, plus ALL while history is short.
export const STABLE_SWAP_RANGES = Object.freeze([
  { id: '7d', label: '1W', days: 7 },
  { id: '30d', label: '1M', days: 30 },
  { id: '90d', label: '3M', days: 90 },
  { id: '180d', label: '6M', days: 180 },
  { id: '365d', label: '1Y', days: 365 },
  { id: 'all', label: 'ALL', days: null }
]);
export const DEFAULT_STABLE_SWAP_RANGE = 'all';

/** @param {{ forceRefresh?: boolean, signal?: AbortSignal }} [options] */
export async function fetchStableSwaps({ forceRefresh = false, signal = undefined } = {}) {
  return booneToolsApi.get('/dynamic-fee-stable-swaps', {
    cache: 'no-store',
    forceRefresh,
    signal,
    query: { days: STABLE_SWAPS_HISTORY_DAYS },
    errorMessage: ({ response }) => `Stable swap history failed (${response.status})`,
    challengeMessage: 'Stable swap backend returned a challenge response'
  });
}

function utcDay(value) {
  const day = String(value ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  // Round-trip so impossible dates (e.g. Feb 30) are rejected, not rolled over.
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : '';
}

/** Finite number or null; empty strings, booleans and objects are not zero. */
function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const nonNegative = (value) => {
  const number = finite(value);
  return number === null || number < 0 ? null : number;
};

/** Effective rate in basis points; unavailable when volume is zero or fees are unknown. */
export function stableSwapFeeBps(feesUsd, volumeUsd) {
  return Number.isFinite(feesUsd) && Number.isFinite(volumeUsd) && volumeUsd > 0
    ? feesUsd / volumeUsd * 10_000 : null;
}

/**
 * Volume-weighted rate for any set of days: sum(fees) / sum(volume). Days with
 * unknown USD fees are excluded from both sides so they cannot dilute the rate.
 */
export function weightedStableSwapFeeBps(rows = []) {
  let fees = 0;
  let volume = 0;
  for (const row of rows) {
    if (!Number.isFinite(row?.feesUsd) || !Number.isFinite(row?.volumeUsd)) continue;
    fees += row.feesUsd;
    volume += row.volumeUsd;
  }
  return stableSwapFeeBps(fees, volume);
}

/** `STABLE MIN FEE 2 → 10 BPS`, with the asset for a per-asset override. */
export function stableSwapMimirLabel(key, value, previousValue = null) {
  const asset = key.includes('-') ? ` ${key.slice(key.indexOf('-') + 1).split('-')[0]}` : '';
  return `STABLE MIN FEE${asset} ${previousValue === null ? '' : `${previousValue} → `}${value} BPS`;
}

export function normalizeStableSwapsPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const byDay = new Map();
  for (const item of Array.isArray(source.days) ? source.days : []) {
    const day = utcDay(item?.day);
    if (!day) continue;
    const volumeUsd = nonNegative(item.volume_usd);
    const feesUsd = nonNegative(item.fees_usd);
    const swaps = nonNegative(item.swaps);
    byDay.set(day, {
      day,
      swaps: swaps === null ? null : Math.round(swaps),
      volumeUsd,
      feesUsd,
      feesRune: nonNegative(item.fees_rune),
      feeBps: stableSwapFeeBps(feesUsd, volumeUsd),
      partial: item.partial === true
    });
  }
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const mimirChanges = (Array.isArray(source.mimir_changes) ? source.mimir_changes : []).flatMap((item) => {
    const day = utcDay(item?.day);
    const key = typeof item?.key === 'string' ? item.key.trim().toUpperCase() : '';
    const value = nonNegative(item?.value);
    return day && key && value !== null
      ? [{ key, day, value, previousValue: nonNegative(item.previous_value), label: stableSwapMimirLabel(key, value, nonNegative(item.previous_value)) }]
      : [];
  }).sort((a, b) => a.day.localeCompare(b.day));
  const backfill = source.backfill && typeof source.backfill === 'object' && !Array.isArray(source.backfill)
    ? {
      targetStart: utcDay(source.backfill.target_start) || null,
      completeFrom: utcDay(source.backfill.complete_from) || null,
      complete: source.backfill.complete === true,
      floorReason: typeof source.backfill.floor_reason === 'string' && source.backfill.floor_reason.trim()
        ? source.backfill.floor_reason.trim() : null
    }
    : null;
  return {
    asOf: typeof source.as_of === 'string' ? source.as_of : null,
    coverageStart: utcDay(source.coverage_start) || null,
    ledgerStart: utcDay(source.ledger_start) || null,
    backfill,
    stableSymbols: Array.isArray(source.stable_symbols)
      ? source.stable_symbols.filter((symbol) => typeof symbol === 'string' && symbol.trim()).map((symbol) => symbol.trim())
      : [],
    source: typeof source.source === 'string' && source.source.trim() ? source.source.trim() : 'finalized-block swap ledger',
    mimirChanges,
    days
  };
}

/**
 * Footer disclosure for the historical backfill: in progress, ended early at an
 * archive floor, or nothing once complete. No progress estimate is invented.
 */
export function stableSwapBackfillNote(dashboard) {
  const backfill = dashboard?.backfill;
  if (!backfill) return '';
  if (!backfill.complete) {
    return backfill.targetStart ? `BACKFILL TO ${backfill.targetStart} UTC IN PROGRESS` : 'BACKFILL IN PROGRESS';
  }
  const coverageStart = dashboard.coverageStart;
  if (backfill.floorReason && backfill.targetStart && coverageStart && coverageStart > backfill.targetStart) {
    return 'HISTORY LIMITED BY ARCHIVE AVAILABILITY';
  }
  return '';
}

export function selectStableSwapRange(rows = [], rangeId = DEFAULT_STABLE_SWAP_RANGE) {
  const ordered = Array.isArray(rows) ? rows : [];
  const range = STABLE_SWAP_RANGES.find((candidate) => candidate.id === rangeId)
    || STABLE_SWAP_RANGES.find((candidate) => candidate.id === DEFAULT_STABLE_SWAP_RANGE);
  if (!range.days || ordered.length <= range.days) return ordered;
  return ordered.slice(-range.days);
}
