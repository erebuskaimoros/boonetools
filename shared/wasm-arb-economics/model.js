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
    tcShare: Math.max(0, Math.min(1, finiteNumber(row.tcShare ?? row.tc_share, 0.5))),
    mimirValue: finiteNumber(row.mimirValue ?? row.mimir_value),
    referenceMimirValue: finiteNumber(
      row.referenceMimirValue ?? row.reference_mimir_value,
      finiteNumber(row.mimirValue ?? row.mimir_value)
    ),
    networkComplete: row.networkComplete ?? row.network_complete ?? true,
    actionsComplete: row.actionsComplete ?? row.actions_complete ?? true,
    feesComplete: row.feesComplete ?? row.fees_complete ?? true
  };
}

export function normalizeWasmArbEconomicsBuckets(rows = []) {
  return rows
    .map(normalizeWasmArbEconomicsBucket)
    .filter((row) => row.startSeconds > 0)
    .sort((left, right) => left.startSeconds - right.startSeconds);
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
  const tcShare = after.averageTcShare || before.averageTcShare || 0.5;
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
    'tcBpsPerWasmInput',
    'tcBpsPerWasmLegVolume',
    'tcCaptureShare'
  ];

  return {
    ready: true,
    dataComplete,
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
    .map(([startSeconds, group]) => ({
      bucketStart: new Date(startSeconds * 1000).toISOString(),
      startSeconds,
      bucketSeconds: size,
      ...summarizeWasmArbWindow(group)
    }));
}
