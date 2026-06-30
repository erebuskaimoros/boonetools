import { safeNumber } from '../lib/utils.js';

const BILLION = 1_000_000_000;

function toDateKey(value) {
  if (!value) return '';
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

export function computeFeesPerBillionUsd(tcFeesUsd, globalExchangeVolumeUsd) {
  const fees = safeNumber(tcFeesUsd);
  const volume = safeNumber(globalExchangeVolumeUsd);
  return fees > 0 && volume > 0 ? (fees / volume) * BILLION : 0;
}

export function normalizeTcFeeDashRow(row) {
  const tcFeesUsd = safeNumber(row.tc_fees_usd);
  const globalExchangeVolumeUsd = safeNumber(row.global_exchange_volume_usd);
  return {
    id: String(row.id || ''),
    period: String(row.period || ''),
    windowStart: toDateKey(row.window_start),
    windowEnd: toDateKey(row.window_end),
    windowLabel: String(row.window_label || ''),
    feeBps: safeNumber(row.fee_bps),
    tcFeesRune: safeNumber(row.tc_fees_rune),
    runePriceUsd: safeNumber(row.rune_price_usd),
    tcFeesUsd,
    cmcVolume24hUsd: safeNumber(row.cmc_volume_24h_usd),
    defillamaDexVolumeUsd: safeNumber(row.defillama_dex_volume_usd),
    globalExchangeVolumeUsd,
    feesPerBillionUsd: computeFeesPerBillionUsd(tcFeesUsd, globalExchangeVolumeUsd),
    dailyMedianFeesPerBillionUsd: safeNumber(row.daily_median_fees_per_billion_usd),
    dailyRangeLowFeesPerBillionUsd: safeNumber(row.daily_range_low_fees_per_billion_usd),
    dailyRangeHighFeesPerBillionUsd: safeNumber(row.daily_range_high_fees_per_billion_usd),
    sourceLabel: String(row.source_label || ''),
    sourceThread: String(row.source_thread || '')
  };
}

export function summarizeTcFeeDashRows(rows) {
  if (!rows.length) {
    return {
      windowCount: 0,
      totalTcFeesUsd: 0,
      totalGlobalExchangeVolumeUsd: 0,
      weightedFeesPerBillionUsd: 0,
      latest: null,
      peak: null
    };
  }

  const totalTcFeesUsd = rows.reduce((sum, row) => sum + row.tcFeesUsd, 0);
  const totalGlobalExchangeVolumeUsd = rows.reduce(
    (sum, row) => sum + row.globalExchangeVolumeUsd,
    0
  );
  const peak = rows.reduce((best, row) => (
    row.feesPerBillionUsd > best.feesPerBillionUsd ? row : best
  ), rows[0]);

  return {
    windowCount: rows.length,
    totalTcFeesUsd,
    totalGlobalExchangeVolumeUsd,
    weightedFeesPerBillionUsd: computeFeesPerBillionUsd(
      totalTcFeesUsd,
      totalGlobalExchangeVolumeUsd
    ),
    latest: rows.at(-1),
    peak
  };
}
