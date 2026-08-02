const FIVE_MINUTES_SECONDS = 300;
const BASIS_POINTS = 10_000;
const MILLION = 1_000_000;

export const WASM_ARB_VOLUME_BASIS = 'executed-leg-usd';
export const WASM_ARB_BUCKET_SECONDS = FIVE_MINUTES_SECONDS;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveRatio(numerator, denominator, scale = 1) {
  const top = finiteNumber(numerator);
  const bottom = finiteNumber(denominator);
  return bottom > 0 ? (top / bottom) * scale : null;
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + finiteNumber(row?.[field]), 0);
}

function max(rows, field) {
  return rows.reduce((highest, row) => Math.max(highest, finiteNumber(row?.[field])), 0);
}

function normalizeHistogram(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  /** @type {Record<string, number>} */
  const normalized = {};
  for (const [key, rawCount] of Object.entries(value)) {
    const count = finiteNumber(rawCount);
    if (count > 0) {
      normalized[String(Math.max(0, Math.trunc(finiteNumber(key))))] = count;
    }
  }
  return normalized;
}

function mergeHistograms(rows, field) {
  const histogram = {};
  for (const row of rows) {
    for (const [key, count] of Object.entries(row?.[field] || {})) {
      histogram[key] = (histogram[key] || 0) + finiteNumber(count);
    }
  }
  return histogram;
}

function histogramQuantile(histogram, quantile) {
  const entries = Object.entries(histogram || {})
    .map(([key, count]) => [finiteNumber(key), finiteNumber(count)])
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left - right);
  const total = entries.reduce((sumValue, [, count]) => sumValue + count, 0);
  if (!(total > 0)) return null;
  const target = Math.max(1, Math.ceil(total * quantile));
  let cumulative = 0;
  for (const [value, count] of entries) {
    cumulative += count;
    if (cumulative >= target) return value;
  }
  return entries.at(-1)?.[0] ?? null;
}

function timestampSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

export function floorWasmArbBucket(value, bucketSeconds = FIVE_MINUTES_SECONDS) {
  const seconds = timestampSeconds(value);
  const size = Math.max(1, Math.trunc(finiteNumber(bucketSeconds, FIVE_MINUTES_SECONDS)));
  return Math.floor(seconds / size) * size;
}

export function ceilWasmArbBucket(value, bucketSeconds = FIVE_MINUTES_SECONDS) {
  const seconds = timestampSeconds(value);
  const size = Math.max(1, Math.trunc(finiteNumber(bucketSeconds, FIVE_MINUTES_SECONDS)));
  return Math.ceil(seconds / size) * size;
}

export function normalizeWasmArbEconomicsBucket(row = {}) {
  const bucketStart = String(row.bucketStart || row.bucket_start || '');
  const startSeconds = timestampSeconds(bucketStart || row.startTime || row.start_time);
  const bucketSeconds = Math.max(
    1,
    Math.trunc(finiteNumber(row.bucketSeconds ?? row.bucket_seconds, FIVE_MINUTES_SECONDS))
  );
  const normalizedStart = startSeconds > 0
    ? new Date(startSeconds * 1000).toISOString()
    : bucketStart;

  return {
    bucketStart: normalizedStart,
    startSeconds,
    bucketSeconds,
    networkVolumeUsd: finiteNumber(row.networkVolumeUsd ?? row.network_volume_usd),
    networkLiquidityFeeRune: finiteNumber(
      row.networkLiquidityFeeRune ?? row.network_liquidity_fee_rune
    ),
    networkLiquidityFeeUsd: finiteNumber(
      row.networkLiquidityFeeUsd ?? row.network_liquidity_fee_usd
    ),
    networkSwapLegCount: finiteNumber(row.networkSwapLegCount ?? row.network_swap_leg_count),
    runePriceUsd: finiteNumber(row.runePriceUsd ?? row.rune_price_usd),
    wasmActionCount: finiteNumber(row.wasmActionCount ?? row.wasm_action_count),
    wasmLegCount: finiteNumber(row.wasmLegCount ?? row.wasm_leg_count),
    wasmSingleActionCount: finiteNumber(
      row.wasmSingleActionCount ?? row.wasm_single_action_count
    ),
    wasmDoubleActionCount: finiteNumber(
      row.wasmDoubleActionCount ?? row.wasm_double_action_count
    ),
    wasmInputVolumeUsd: finiteNumber(row.wasmInputVolumeUsd ?? row.wasm_input_volume_usd),
    wasmLegVolumeUsd: finiteNumber(row.wasmLegVolumeUsd ?? row.wasm_leg_volume_usd),
    wasmLiquidityFeeRune: finiteNumber(
      row.wasmLiquidityFeeRune ?? row.wasm_liquidity_fee_rune
    ),
    wasmLiquidityFeeUsd: finiteNumber(
      row.wasmLiquidityFeeUsd ?? row.wasm_liquidity_fee_usd
    ),
    zeroSlipActionCount: finiteNumber(row.zeroSlipActionCount ?? row.zero_slip_action_count),
    zeroFeeActionCount: finiteNumber(row.zeroFeeActionCount ?? row.zero_fee_action_count),
    belowReferenceActionCount: finiteNumber(
      row.belowReferenceActionCount ?? row.below_reference_action_count
    ),
    slipHistogram: normalizeHistogram(row.slipHistogram ?? row.slip_histogram),
    medianSlipBps: nullableNumber(row.medianSlipBps ?? row.median_slip_bps),
    p90SlipBps: nullableNumber(row.p90SlipBps ?? row.p90_slip_bps),
    maxSlipBps: nullableNumber(row.maxSlipBps ?? row.max_slip_bps),
    ammFeeUsd: finiteNumber(row.ammFeeUsd ?? row.amm_fee_usd),
    finFeeUsd: finiteNumber(row.finFeeUsd ?? row.fin_fee_usd),
    finRangeFeeUsd: finiteNumber(row.finRangeFeeUsd ?? row.fin_range_fee_usd),
    linkedAmmFeeUsd: finiteNumber(row.linkedAmmFeeUsd ?? row.linked_amm_fee_usd),
    linkedFinFeeUsd: finiteNumber(row.linkedFinFeeUsd ?? row.linked_fin_fee_usd),
    linkedFinRangeFeeUsd: finiteNumber(
      row.linkedFinRangeFeeUsd ?? row.linked_fin_range_fee_usd
    ),
    rujiraFeeEventCount: finiteNumber(row.rujiraFeeEventCount ?? row.rujira_fee_event_count),
    unpricedRujiraFeeEventCount: finiteNumber(
      row.unpricedRujiraFeeEventCount ?? row.unpriced_rujira_fee_event_count
    ),
    oracleObservationCount: finiteNumber(
      row.oracleObservationCount ?? row.oracle_observation_count
    ),
    oracleAbsDeviationSumBps: finiteNumber(
      row.oracleAbsDeviationSumBps ?? row.oracle_abs_deviation_sum_bps
    ),
    oracleSignedDeviationSumBps: finiteNumber(
      row.oracleSignedDeviationSumBps ?? row.oracle_signed_deviation_sum_bps
    ),
    oracleWeightedAbsNumerator: finiteNumber(
      row.oracleWeightedAbsNumerator ?? row.oracle_weighted_abs_numerator
    ),
    oracleDepthWeightUsd: finiteNumber(
      row.oracleDepthWeightUsd ?? row.oracle_depth_weight_usd
    ),
    oracleWithin10Count: finiteNumber(row.oracleWithin10Count ?? row.oracle_within_10_count),
    oracleWithin25Count: finiteNumber(row.oracleWithin25Count ?? row.oracle_within_25_count),
    oracleMaxAbsDeviationBps: finiteNumber(
      row.oracleMaxAbsDeviationBps ?? row.oracle_max_abs_deviation_bps
    ),
    oracleExLtcObservationCount: finiteNumber(
      row.oracleExLtcObservationCount ?? row.oracle_ex_ltc_observation_count
    ),
    oracleExLtcAbsDeviationSumBps: finiteNumber(
      row.oracleExLtcAbsDeviationSumBps ?? row.oracle_ex_ltc_abs_deviation_sum_bps
    ),
    oracleExLtcSignedDeviationSumBps: finiteNumber(
      row.oracleExLtcSignedDeviationSumBps ?? row.oracle_ex_ltc_signed_deviation_sum_bps
    ),
    oracleExLtcWeightedAbsNumerator: finiteNumber(
      row.oracleExLtcWeightedAbsNumerator ?? row.oracle_ex_ltc_weighted_abs_numerator
    ),
    oracleExLtcDepthWeightUsd: finiteNumber(
      row.oracleExLtcDepthWeightUsd ?? row.oracle_ex_ltc_depth_weight_usd
    ),
    oracleExLtcWithin10Count: finiteNumber(
      row.oracleExLtcWithin10Count ?? row.oracle_ex_ltc_within_10_count
    ),
    oracleExLtcWithin25Count: finiteNumber(
      row.oracleExLtcWithin25Count ?? row.oracle_ex_ltc_within_25_count
    ),
    oracleExLtcMaxAbsDeviationBps: finiteNumber(
      row.oracleExLtcMaxAbsDeviationBps ?? row.oracle_ex_ltc_max_abs_deviation_bps
    ),
    tcShare: Math.max(0, Math.min(1, finiteNumber(row.tcShare ?? row.tc_share, 0.5))),
    mimirValue: finiteNumber(row.mimirValue ?? row.mimir_value),
    referenceMimirValue: finiteNumber(
      row.referenceMimirValue ?? row.reference_mimir_value,
      finiteNumber(row.mimirValue ?? row.mimir_value)
    ),
    networkComplete: row.networkComplete ?? row.network_complete ?? true,
    actionsComplete: row.actionsComplete ?? row.actions_complete ?? true,
    feesComplete: row.feesComplete ?? row.fees_complete ?? true,
    oracleComplete: row.oracleComplete ?? row.oracle_complete ?? false
  };
}

export function normalizeWasmArbEconomicsBuckets(rows = []) {
  return rows
    .map(normalizeWasmArbEconomicsBucket)
    .filter((row) => row.startSeconds > 0)
    .sort((left, right) => left.startSeconds - right.startSeconds);
}

function summarizePriceTracking(rows, prefix = 'oracle') {
  const field = (suffix) => `${prefix}${suffix}`;
  const observations = sum(rows, field('ObservationCount'));
  const depthWeightUsd = sum(rows, field('DepthWeightUsd'));
  return {
    observations,
    depthWeightedAbsoluteDeviationBps: positiveRatio(
      sum(rows, field('WeightedAbsNumerator')),
      depthWeightUsd
    ),
    meanAbsoluteDeviationBps: positiveRatio(
      sum(rows, field('AbsDeviationSumBps')),
      observations
    ),
    meanSignedDeviationBps: positiveRatio(
      sum(rows, field('SignedDeviationSumBps')),
      observations
    ),
    within10Share: positiveRatio(sum(rows, field('Within10Count')), observations),
    within25Share: positiveRatio(sum(rows, field('Within25Count')), observations),
    maxAbsoluteDeviationBps: observations > 0
      ? max(rows, field('MaxAbsDeviationBps'))
      : null,
    depthWeightUsd
  };
}

export function summarizeWasmArbWindow(rows = []) {
  const normalized = normalizeWasmArbEconomicsBuckets(rows);
  const wasmLiquidityFeeUsd = sum(normalized, 'wasmLiquidityFeeUsd');
  const linkedRujiraFeeUsd = sum(normalized, 'linkedAmmFeeUsd')
    + sum(normalized, 'linkedFinFeeUsd');
  const allRujiraFeeUsd = sum(normalized, 'ammFeeUsd') + sum(normalized, 'finFeeUsd');
  const linkedTcReserveUsd = normalized.reduce(
    (total, row) => total + (row.linkedAmmFeeUsd + row.linkedFinFeeUsd) * row.tcShare,
    0
  );
  const broadTcReserveUsd = normalized.reduce(
    (total, row) => total + (row.ammFeeUsd + row.finFeeUsd) * row.tcShare,
    0
  );
  const wasmActionCount = sum(normalized, 'wasmActionCount');
  const wasmInputVolumeUsd = sum(normalized, 'wasmInputVolumeUsd');
  const wasmLegVolumeUsd = sum(normalized, 'wasmLegVolumeUsd');
  const networkVolumeUsd = sum(normalized, 'networkVolumeUsd');
  const networkLiquidityFeeUsd = sum(normalized, 'networkLiquidityFeeUsd');
  const rujiraFeeEventCount = sum(normalized, 'rujiraFeeEventCount');
  const unpricedRujiraFeeEventCount = sum(normalized, 'unpricedRujiraFeeEventCount');
  const tcLinkedValueUsd = wasmLiquidityFeeUsd + linkedTcReserveUsd;
  const tcBroadValueUsd = wasmLiquidityFeeUsd + broadTcReserveUsd;
  const slipHistogram = mergeHistograms(normalized, 'slipHistogram');
  const totalWeight = normalized.reduce((total, row) => total + row.bucketSeconds, 0);
  const averageTcShare = totalWeight > 0
    ? normalized.reduce((total, row) => total + row.tcShare * row.bucketSeconds, 0) / totalWeight
    : 0.5;
  const priceTracking = summarizePriceTracking(normalized);
  const priceTrackingExcludingLtc = summarizePriceTracking(normalized, 'oracleExLtc');

  return {
    bucketCount: normalized.length,
    startTime: normalized[0]?.bucketStart || null,
    endTime: normalized.length
      ? new Date(
          (normalized.at(-1).startSeconds + normalized.at(-1).bucketSeconds) * 1000
        ).toISOString()
      : null,
    networkVolumeUsd,
    networkLiquidityFeeRune: sum(normalized, 'networkLiquidityFeeRune'),
    networkLiquidityFeeUsd,
    networkSwapLegCount: sum(normalized, 'networkSwapLegCount'),
    wasmActionCount,
    wasmLegCount: sum(normalized, 'wasmLegCount'),
    wasmSingleActionCount: sum(normalized, 'wasmSingleActionCount'),
    wasmDoubleActionCount: sum(normalized, 'wasmDoubleActionCount'),
    wasmInputVolumeUsd,
    wasmLegVolumeUsd,
    wasmLiquidityFeeRune: sum(normalized, 'wasmLiquidityFeeRune'),
    wasmLiquidityFeeUsd,
    zeroSlipActionCount: sum(normalized, 'zeroSlipActionCount'),
    zeroFeeActionCount: sum(normalized, 'zeroFeeActionCount'),
    belowReferenceActionCount: sum(normalized, 'belowReferenceActionCount'),
    slipHistogram,
    medianSlipBps: histogramQuantile(slipHistogram, 0.5),
    p90SlipBps: histogramQuantile(slipHistogram, 0.9),
    maxSlipBps: histogramQuantile(slipHistogram, 1),
    ammFeeUsd: sum(normalized, 'ammFeeUsd'),
    finFeeUsd: sum(normalized, 'finFeeUsd'),
    finRangeFeeUsd: sum(normalized, 'finRangeFeeUsd'),
    linkedAmmFeeUsd: sum(normalized, 'linkedAmmFeeUsd'),
    linkedFinFeeUsd: sum(normalized, 'linkedFinFeeUsd'),
    linkedFinRangeFeeUsd: sum(normalized, 'linkedFinRangeFeeUsd'),
    linkedRujiraFeeUsd,
    allRujiraFeeUsd,
    linkedTcReserveUsd,
    broadTcReserveUsd,
    tcLinkedValueUsd,
    tcBroadValueUsd,
    averageTcShare,
    rujiraFeeEventCount,
    unpricedRujiraFeeEventCount,
    pricingCoverage: rujiraFeeEventCount > 0
      ? Math.max(0, 1 - unpricedRujiraFeeEventCount / rujiraFeeEventCount)
      : 1,
    priceTracking,
    priceTrackingExcludingLtc,
    oracleCoverageComplete: normalized.length > 0
      && normalized.every((row) => row.oracleComplete),
    oracleBucketCoverage: normalized.length
      ? normalized.filter((row) => row.oracleObservationCount > 0).length / normalized.length
      : 0,
    networkBucketCoverage: normalized.length
      ? normalized.filter((row) => row.networkComplete).length / normalized.length
      : 0,
    actionBucketCoverage: normalized.length
      ? normalized.filter((row) => row.actionsComplete).length / normalized.length
      : 0,
    feeBucketCoverage: normalized.length
      ? normalized.filter((row) => row.feesComplete).length / normalized.length
      : 0,
    wasmNetworkVolumeShare: positiveRatio(wasmLegVolumeUsd, networkVolumeUsd),
    wasmNetworkFeeShare: positiveRatio(wasmLiquidityFeeUsd, networkLiquidityFeeUsd),
    wasmNetworkLegShare: positiveRatio(
      sum(normalized, 'wasmLegCount'),
      sum(normalized, 'networkSwapLegCount')
    ),
    zeroSlipShare: positiveRatio(sum(normalized, 'zeroSlipActionCount'), wasmActionCount),
    zeroFeeShare: positiveRatio(sum(normalized, 'zeroFeeActionCount'), wasmActionCount),
    belowReferenceShare: positiveRatio(
      sum(normalized, 'belowReferenceActionCount'),
      wasmActionCount
    ),
    networkFeeBps: positiveRatio(networkLiquidityFeeUsd, networkVolumeUsd, BASIS_POINTS),
    wasmInputFeeBps: positiveRatio(wasmLiquidityFeeUsd, wasmInputVolumeUsd, BASIS_POINTS),
    wasmLegFeeBps: positiveRatio(wasmLiquidityFeeUsd, wasmLegVolumeUsd, BASIS_POINTS),
    tcPerActionUsd: positiveRatio(tcLinkedValueUsd, wasmActionCount),
    tcPerMillionNetworkVolumeUsd: positiveRatio(tcLinkedValueUsd, networkVolumeUsd, MILLION),
    tcBroadPerMillionNetworkVolumeUsd: positiveRatio(
      tcBroadValueUsd,
      networkVolumeUsd,
      MILLION
    ),
    tcPerMillionWasmVolumeUsd: positiveRatio(tcLinkedValueUsd, wasmLegVolumeUsd, MILLION),
    tcBroadPerMillionWasmVolumeUsd: positiveRatio(
      tcBroadValueUsd,
      wasmLegVolumeUsd,
      MILLION
    ),
    tcBpsPerWasmInput: positiveRatio(tcLinkedValueUsd, wasmInputVolumeUsd, BASIS_POINTS),
    tcBpsPerWasmLegVolume: positiveRatio(tcLinkedValueUsd, wasmLegVolumeUsd, BASIS_POINTS),
    tcCaptureShare: positiveRatio(tcLinkedValueUsd, wasmLiquidityFeeUsd + linkedRujiraFeeUsd)
  };
}

function delta(before, after) {
  const left = nullableNumber(before);
  const right = nullableNumber(after);
  if (left === null || right === null) return { absolute: null, percent: null };
  return {
    absolute: right - left,
    percent: left !== 0 ? (right - left) / Math.abs(left) : null
  };
}

function windowCoverage(rows, start, end, bucketSeconds) {
  const expected = Math.max(0, Math.round((end - start) / bucketSeconds));
  return {
    expected,
    observed: rows.length,
    ratio: expected > 0 ? rows.length / expected : 0
  };
}

export function compareWasmArbEqualWindows(rows = [], options = {}) {
  const normalized = normalizeWasmArbEconomicsBuckets(rows);
  const changeSeconds = timestampSeconds(options.anchorTime);
  const postStart = ceilWasmArbBucket(options.anchorTime);
  const preEnd = floorWasmArbBucket(options.anchorTime);
  const latestEnd = normalized.reduce(
    (latest, row) => Math.max(latest, row.startSeconds + row.bucketSeconds),
    0
  );
  const requestedSeconds = Math.max(
    FIVE_MINUTES_SECONDS,
    Math.trunc(finiteNumber(options.windowSeconds, 24 * 60 * 60) / FIVE_MINUTES_SECONDS)
      * FIVE_MINUTES_SECONDS
  );
  const availableSeconds = Math.max(
    0,
    Math.floor((latestEnd - postStart) / FIVE_MINUTES_SECONDS) * FIVE_MINUTES_SECONDS
  );
  const windowSeconds = Math.min(requestedSeconds, availableSeconds);

  if (!(changeSeconds > 0) || windowSeconds < FIVE_MINUTES_SECONDS) {
    return {
      ready: false,
      reason: 'The post-change window has not accumulated a complete five-minute bucket yet.'
    };
  }

  const bounds = {
    preStart: preEnd - windowSeconds,
    preEnd,
    postStart,
    postEnd: postStart + windowSeconds
  };
  const preRows = normalized.filter(
    (row) => row.startSeconds >= bounds.preStart && row.startSeconds < bounds.preEnd
  );
  const postRows = normalized.filter(
    (row) => row.startSeconds >= bounds.postStart && row.startSeconds < bounds.postEnd
  );
  const preCoverage = windowCoverage(
    preRows,
    bounds.preStart,
    bounds.preEnd,
    FIVE_MINUTES_SECONDS
  );
  const postCoverage = windowCoverage(
    postRows,
    bounds.postStart,
    bounds.postEnd,
    FIVE_MINUTES_SECONDS
  );
  const minimumCoverage = finiteNumber(options.minimumCoverage, 0.98);
  if (preCoverage.ratio < minimumCoverage || postCoverage.ratio < minimumCoverage) {
    return {
      ready: false,
      reason: 'Equal-window source buckets are still backfilling.',
      bounds,
      coverage: { pre: preCoverage, post: postCoverage }
    };
  }

  const before = summarizeWasmArbWindow(preRows);
  const after = summarizeWasmArbWindow(postRows);
  const lpFeeDelta = delta(before.wasmLiquidityFeeUsd, after.wasmLiquidityFeeUsd);
  const linkedRujiraDelta = delta(before.linkedRujiraFeeUsd, after.linkedRujiraFeeUsd);
  const reserveDelta = delta(before.linkedTcReserveUsd, after.linkedTcReserveUsd);
  const tcLinkedDelta = delta(before.tcLinkedValueUsd, after.tcLinkedValueUsd);
  const lpFeeLossUsd = Math.max(0, -finiteNumber(lpFeeDelta.absolute));
  const tcShare = after.bucketCount > 0
    ? after.averageTcShare
    : before.bucketCount > 0
      ? before.averageTcShare
      : 0.5;
  const breakEvenRujiraIncreaseUsd = tcShare > 0 ? lpFeeLossUsd / tcShare : null;
  const actualRujiraIncreaseUsd = finiteNumber(linkedRujiraDelta.absolute);
  const breakEvenCoverage = lpFeeLossUsd > 0
    ? finiteNumber(reserveDelta.absolute) / lpFeeLossUsd
    : null;
  const dataComplete = [before, after].every((window) => (
    window.networkBucketCoverage >= minimumCoverage
      && window.actionBucketCoverage >= minimumCoverage
      && window.feeBucketCoverage >= minimumCoverage
      && window.pricingCoverage >= minimumCoverage
  ));
  const priceDataComplete = [before, after].every((window) => (
    window.oracleCoverageComplete
      && window.oracleBucketCoverage >= minimumCoverage
      && window.priceTracking.observations > 0
  ));
  const netDelta = finiteNumber(tcLinkedDelta.absolute);
  const verdict = !dataComplete
    ? 'incomplete'
    : netDelta > 0
      ? 'positive'
      : netDelta < 0
        ? 'negative'
        : 'flat';

  const metricKeys = [
    'networkVolumeUsd',
    'networkLiquidityFeeUsd',
    'wasmActionCount',
    'wasmInputVolumeUsd',
    'wasmLegVolumeUsd',
    'wasmLiquidityFeeUsd',
    'linkedRujiraFeeUsd',
    'allRujiraFeeUsd',
    'linkedTcReserveUsd',
    'tcLinkedValueUsd',
    'tcBroadValueUsd',
    'wasmNetworkVolumeShare',
    'wasmNetworkFeeShare',
    'wasmNetworkLegShare',
    'zeroSlipShare',
    'zeroFeeShare',
    'belowReferenceShare',
    'networkFeeBps',
    'wasmInputFeeBps',
    'wasmLegFeeBps',
    'tcPerActionUsd',
    'tcPerMillionNetworkVolumeUsd',
    'tcBroadPerMillionNetworkVolumeUsd',
    'tcPerMillionWasmVolumeUsd',
    'tcBroadPerMillionWasmVolumeUsd',
    'tcBpsPerWasmInput',
    'tcBpsPerWasmLegVolume',
    'tcCaptureShare'
  ];

  return {
    ready: true,
    dataComplete,
    priceDataComplete,
    verdict,
    requestedSeconds,
    windowSeconds,
    truncated: windowSeconds < requestedSeconds,
    bounds,
    coverage: { pre: preCoverage, post: postCoverage },
    before,
    after,
    deltas: Object.fromEntries(metricKeys.map((key) => [key, delta(before[key], after[key])])),
    breakEven: {
      lpFeeLossUsd,
      tcShare,
      breakEvenRujiraIncreaseUsd,
      actualRujiraIncreaseUsd,
      coverage: breakEvenCoverage
    }
  };
}

const SOURCE_ADDITIVE_FIELDS = Object.freeze([
  'networkVolumeUsd',
  'networkLiquidityFeeRune',
  'networkLiquidityFeeUsd',
  'networkSwapLegCount',
  'wasmActionCount',
  'wasmLegCount',
  'wasmSingleActionCount',
  'wasmDoubleActionCount',
  'wasmInputVolumeUsd',
  'wasmLegVolumeUsd',
  'wasmLiquidityFeeRune',
  'wasmLiquidityFeeUsd',
  'zeroSlipActionCount',
  'zeroFeeActionCount',
  'belowReferenceActionCount',
  'ammFeeUsd',
  'finFeeUsd',
  'finRangeFeeUsd',
  'linkedAmmFeeUsd',
  'linkedFinFeeUsd',
  'linkedFinRangeFeeUsd',
  'rujiraFeeEventCount',
  'unpricedRujiraFeeEventCount',
  'oracleObservationCount',
  'oracleAbsDeviationSumBps',
  'oracleSignedDeviationSumBps',
  'oracleWeightedAbsNumerator',
  'oracleDepthWeightUsd',
  'oracleWithin10Count',
  'oracleWithin25Count',
  'oracleExLtcObservationCount',
  'oracleExLtcAbsDeviationSumBps',
  'oracleExLtcSignedDeviationSumBps',
  'oracleExLtcWeightedAbsNumerator',
  'oracleExLtcDepthWeightUsd',
  'oracleExLtcWithin10Count',
  'oracleExLtcWithin25Count'
]);

function weightedAverage(rows, valueField, weightField) {
  const weight = sum(rows, weightField);
  if (!(weight > 0)) return null;
  return rows.reduce(
    (total, row) => total + finiteNumber(row?.[valueField]) * finiteNumber(row?.[weightField]),
    0
  ) / weight;
}

/**
 * Compact canonical source buckets without losing any additive accounting
 * fields. Unlike summarizeWasmArbWindow(), this returns the same bucket
 * contract that the API and frontend normalizer consume, so compacted rows can
 * be summarized again without double counting FIN range fees or TC allocation.
 */
export function aggregateWasmArbSourceBuckets(rows = [], grainSeconds = 60 * 60) {
  const normalized = normalizeWasmArbEconomicsBuckets(rows);
  const size = Math.max(
    FIVE_MINUTES_SECONDS,
    Math.trunc(finiteNumber(grainSeconds, 60 * 60) / FIVE_MINUTES_SECONDS)
      * FIVE_MINUTES_SECONDS
  );
  const groups = new Map();

  for (const row of normalized) {
    const key = Math.floor(row.startSeconds / size) * size;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, group]) => {
      const first = group[0];
      const last = group.at(-1);
      const slipHistogram = mergeHistograms(group, 'slipHistogram');
      const linkedFeeWeight = group.reduce(
        (total, row) => total + row.linkedAmmFeeUsd + row.linkedFinFeeUsd,
        0
      );
      const durationWeight = group.reduce((total, row) => total + row.bucketSeconds, 0);
      const tcShare = linkedFeeWeight > 0
        ? group.reduce(
            (total, row) => total
              + (row.linkedAmmFeeUsd + row.linkedFinFeeUsd) * row.tcShare,
            0
          ) / linkedFeeWeight
        : durationWeight > 0
          ? group.reduce((total, row) => total + row.tcShare * row.bucketSeconds, 0)
            / durationWeight
          : 0.5;
      const runePriceUsd = weightedAverage(group, 'runePriceUsd', 'networkVolumeUsd')
        ?? weightedAverage(group, 'runePriceUsd', 'bucketSeconds')
        ?? 0;
      const result = {
        bucketStart: first.bucketStart,
        bucketSeconds: durationWeight,
        runePriceUsd,
        slipHistogram,
        medianSlipBps: histogramQuantile(slipHistogram, 0.5),
        p90SlipBps: histogramQuantile(slipHistogram, 0.9),
        maxSlipBps: histogramQuantile(slipHistogram, 1),
        oracleMaxAbsDeviationBps: max(group, 'oracleMaxAbsDeviationBps'),
        oracleExLtcMaxAbsDeviationBps: max(group, 'oracleExLtcMaxAbsDeviationBps'),
        tcShare,
        mimirValue: last.mimirValue,
        referenceMimirValue: first.referenceMimirValue,
        networkComplete: group.every((row) => row.networkComplete),
        actionsComplete: group.every((row) => row.actionsComplete),
        feesComplete: group.every((row) => row.feesComplete),
        oracleComplete: group.every((row) => row.oracleComplete)
      };

      for (const field of SOURCE_ADDITIVE_FIELDS) {
        result[field] = sum(group, field);
      }
      return result;
    });
}

/**
 * Keep the public monitoring payload bounded over time: recent history remains
 * hourly, while older post-change history is represented by daily buckets.
 */
export function compactWasmArbMonitoringRows(rows = [], options = {}) {
  const normalized = normalizeWasmArbEconomicsBuckets(rows);
  const recentSeconds = Math.max(
    24 * 60 * 60,
    Math.trunc(finiteNumber(options.recentSeconds, 30 * 24 * 60 * 60))
  );
  const recentGrainSeconds = Math.max(
    FIVE_MINUTES_SECONDS,
    Math.trunc(finiteNumber(options.recentGrainSeconds, 60 * 60))
  );
  const historicalGrainSeconds = Math.max(
    recentGrainSeconds,
    Math.trunc(finiteNumber(options.historicalGrainSeconds, 24 * 60 * 60))
  );
  const latestEnd = normalized.reduce(
    (latest, row) => Math.max(latest, row.startSeconds + row.bucketSeconds),
    0
  );
  if (!(latestEnd > 0)) {
    return {
      rows: [],
      recentStart: null,
      sourceRowCount: 0,
      recentRowCount: 0,
      historicalRowCount: 0,
      recentGrainSeconds,
      historicalGrainSeconds
    };
  }

  const recentStartSeconds = floorWasmArbBucket(
    latestEnd - recentSeconds,
    historicalGrainSeconds
  );
  const historical = normalized.filter((row) => row.startSeconds < recentStartSeconds);
  const recent = normalized.filter((row) => row.startSeconds >= recentStartSeconds);
  const historicalRows = aggregateWasmArbSourceBuckets(historical, historicalGrainSeconds);
  const recentRows = aggregateWasmArbSourceBuckets(recent, recentGrainSeconds);

  return {
    rows: [...historicalRows, ...recentRows],
    recentStart: new Date(recentStartSeconds * 1000).toISOString(),
    sourceRowCount: normalized.length,
    recentRowCount: recentRows.length,
    historicalRowCount: historicalRows.length,
    recentGrainSeconds,
    historicalGrainSeconds
  };
}

export function aggregateWasmArbEconomicsBuckets(rows = [], grainSeconds = 60 * 60) {
  const normalized = normalizeWasmArbEconomicsBuckets(rows);
  const size = Math.max(FIVE_MINUTES_SECONDS, Math.trunc(finiteNumber(grainSeconds, 3600)));
  const groups = new Map();

  for (const row of normalized) {
    const start = Math.floor(row.startSeconds / size) * size;
    const group = groups.get(start) || [];
    group.push(row);
    groups.set(start, group);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([startSeconds, group]) => {
      const observedSeconds = group.reduce(
        (total, row) => total + finiteNumber(row.bucketSeconds),
        0
      );
      return {
        bucketStart: new Date(startSeconds * 1000).toISOString(),
        startSeconds,
        bucketSeconds: size,
        observedSeconds,
        partial: observedSeconds < size,
        ...summarizeWasmArbWindow(group)
      };
    });
}
