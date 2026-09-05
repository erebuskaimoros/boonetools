import { fetchMidgard } from './midgard.js';
import { POOL_ANALYSIS_TABLE_PERIODS, parsePoolAnalysisSwapInterval, nonNegativeBaseString } from './pool-analysis.js';

const DAY = 86400;
export const POOL_ANALYSIS_SNAPSHOT_SECONDS = 900;
const day = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const midnight = (seconds) => Math.floor(seconds / DAY) * DAY;
const zero = (asset, seconds) => ({ asset, day: day(seconds), interval_start: iso(seconds), interval_end: iso(seconds),
  volume_rune_e8: '0', volume_usd_e2: '0', fees_rune_e8: '0', rune_price_usd: '0', partial: true });
const amountKeys = ['volume_rune_e8', 'volume_usd_e2', 'fees_rune_e8'];
const valid = (row) => row && amountKeys.every((key) => nonNegativeBaseString(row[key]) !== null)
  && (String(row.fees_rune_e8) === '0' || Number(row.rune_price_usd) > 0);
const feeUsd = (row) => Number(row.fees_rune_e8) / 1e8 * Number(row.rune_price_usd);

// One cumulative current-day prefix replaces the existing live-day query.
export async function fetchPoolAnalysisSnapshot(asset, cutoff, options = {}) {
  if (!Number.isSafeInteger(cutoff) || cutoff <= 0) throw new Error('Invalid snapshot cutoff');
  cutoff = Math.floor(cutoff / POOL_ANALYSIS_SNAPSHOT_SECONDS) * POOL_ANALYSIS_SNAPSHOT_SECONDS;
  const from = midnight(cutoff);
  let head;
  if (from === cutoff) head = zero(asset, cutoff);
  else {
    const params = new URLSearchParams({ pool: asset, from: String(from), to: String(cutoff) });
    options.onRequest?.();
    const payload = await (options.fetchMidgard || fetchMidgard)(`/history/swaps?${params}`, {
      cooldownClient: options.client, ...(options.bases ? { bases: options.bases } : {}),
      validateResponse: (_path, value) => !value?.meta
    });
    const value = payload?.meta;
    if (Number(value?.startTime) !== from || Number(value?.endTime) !== cutoff) {
      throw new Error(`Midgard snapshot bounds do not match ${from}..${cutoff}`);
    }
    head = parsePoolAnalysisSwapInterval(value, { asset, partial: true });
    if (!valid(head)) throw new Error('Incomplete Midgard snapshot amounts');
  }
  if (options.onHead) await options.onHead(head);
  return { asset, cutoff, head };
}

export function combinePoolAnalysisSnapshots({ asset, cutoff, head }, daily = [], prefixes = []) {
  const byDay = new Map(daily.map((row) => [row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10), row]));
  const byEnd = new Map(prefixes.map((row) => [new Date(row.bucket_end).getTime() / 1000, row]));
  const complete = (row) => valid(row) && !row.partial && Boolean(row.completed_at);
  function completed(from, to, requireFinality = true) {
    const rows = [];
    let missing = 0;
    for (let cursor = from; cursor < to; cursor += DAY) {
      const row = byDay.get(day(cursor));
      if (requireFinality ? complete(row) : valid(row) && !row.partial) rows.push(row); else missing++;
    }
    return { rows, missing };
  }
  return POOL_ANALYSIS_TABLE_PERIODS.map((period) => {
    const from = cutoff - period.days * DAY;
    const boundary = byEnd.get(from);
    const firstDay = byDay.get(day(from));
    const aligned = from === midnight(from);
    const interior = completed(Math.ceil(from / DAY) * DAY, midnight(cutoff));
    let ready = aligned || (valid(boundary) && complete(firstDay)
      && amountKeys.every((key) => BigInt(firstDay[key]) >= BigInt(boundary[key])));
    // A historical gap cannot be made exact from a newer cumulative sample.
    ready = Boolean(ready && interior.missing === 0);
    let rows, missing, subtract;
    if (ready) {
      rows = [...interior.rows, head, ...(aligned ? [] : [firstDay])];
      missing = 0;
      subtract = aligned ? zero(asset, from) : boundary;
    } else {
      const fallback = completed(midnight(cutoff) - period.days * DAY, midnight(cutoff), false);
      rows = fallback.rows;
      missing = fallback.missing;
      subtract = zero(asset, midnight(cutoff));
    }
    const sum = (key) => missing ? null : (rows.reduce((total, row) => total + BigInt(row[key]), 0n) - BigInt(subtract[key])).toString();
    const estimatedFeesUsd = missing ? null : ready && !aligned
      ? [...interior.rows, head].reduce((total, row) => total + feeUsd(row), 0)
        + Number(BigInt(firstDay.fees_rune_e8) - BigInt(boundary.fees_rune_e8)) / 1e8 * Number(firstDay.rune_price_usd)
      : rows.reduce((total, row) => total + feeUsd(row), 0);
    const start = ready ? from : midnight(cutoff) - period.days * DAY;
    const end = ready ? cutoff : midnight(cutoff);
    return { asset, period_id: period.id, period_days: period.days,
      window_mode: ready ? 'rolling' : 'completed-days', snapshot_ready: ready, snapshot_resolution_seconds: POOL_ANALYSIS_SNAPSHOT_SECONDS,
      window_start: iso(start), window_end: iso(end), first_day: day(start), last_day: day(end - 1),
      observed_days: period.days - missing, missing_days: missing, incomplete: missing > 0,
      volume_rune_e8: sum('volume_rune_e8'), volume_usd: missing ? null : Number(sum('volume_usd_e2')) / 100,
      fees_rune_e8: sum('fees_rune_e8'), fees_usd: estimatedFeesUsd !== null && estimatedFeesUsd >= 0 ? estimatedFeesUsd : null,
      usd_fee_estimate: true, snapshot_cutoff: iso(cutoff), source_updated_at: iso(cutoff) };
  });
}
