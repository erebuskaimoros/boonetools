// Fee-efficiency math shared by the TC Fee Dash read model and dashboard.
const BILLION = 1_000_000_000;
const BASIS_POINTS = 10_000;

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function computeFeesPerBillionUsd(tcFeesUsd, globalExchangeVolumeUsd) {
  const fees = finiteNumber(tcFeesUsd);
  const volume = finiteNumber(globalExchangeVolumeUsd);
  return fees > 0 && volume > 0 ? (fees / volume) * BILLION : 0;
}

export function computeIncomeVolumeBps(incomeUsd, thorchainVolumeUsd) {
  const income = finiteNumber(incomeUsd);
  const volume = finiteNumber(thorchainVolumeUsd);
  return income >= 0 && volume > 0 ? (income / volume) * BASIS_POINTS : null;
}

/** Ratios are recomputed from summed fees and volume; rows must already be normalized. */
export function summarizeTcFeeRows(rows) {
  if (!rows.length) {
    return {
      windowCount: 0,
      totalTcFeesUsd: 0,
      totalGlobalExchangeVolumeUsd: 0,
      totalThorchainVolumeUsd: 0,
      weightedFeesPerBillionUsd: 0,
      weightedIncomeVolumeBps: null,
      latest: null,
      peak: null
    };
  }

  const totalTcFeesUsd = rows.reduce((sum, row) => sum + row.tcFeesUsd, 0);
  const totalGlobalExchangeVolumeUsd = rows.reduce((sum, row) => sum + row.globalExchangeVolumeUsd, 0);
  const totalThorchainVolumeUsd = rows.reduce((sum, row) => sum + row.thorchainVolumeUsd, 0);
  const peak = rows.reduce((best, row) => (
    row.feesPerBillionUsd > best.feesPerBillionUsd ? row : best
  ), rows[0]);

  return {
    windowCount: rows.length,
    totalTcFeesUsd,
    totalGlobalExchangeVolumeUsd,
    totalThorchainVolumeUsd,
    weightedFeesPerBillionUsd: computeFeesPerBillionUsd(totalTcFeesUsd, totalGlobalExchangeVolumeUsd),
    weightedIncomeVolumeBps: computeIncomeVolumeBps(totalTcFeesUsd, totalThorchainVolumeUsd),
    latest: rows.at(-1),
    peak
  };
}
