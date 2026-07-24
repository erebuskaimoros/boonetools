const DAY_SECONDS = 24 * 60 * 60;
const RUNE_ASSET = 'THOR.RUNE';

export const EXECUTED_LEG_VOLUME_BASIS = 'executed-leg-usd';

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeAsset(value) {
  return String(value || '').trim().toUpperCase().replace('~', '.');
}

function firstCoin(legs = [], predicate = () => true) {
  for (const leg of Array.isArray(legs) ? legs : []) {
    if (!predicate(leg)) continue;
    if (Array.isArray(leg?.coins) && leg.coins[0]) return leg.coins[0];
  }
  return null;
}

function actionEndHeight(action) {
  const startHeight = Math.max(0, Math.trunc(safeNumber(action?.height, 0)));
  const lastHeight = Math.max(
    0,
    Math.trunc(safeNumber(action?.metadata?.swap?.streamingSwapMeta?.lastHeight, 0))
  );
  return Math.max(startHeight, lastHeight);
}

export function midgardActionTimestampSeconds(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;

  try {
    const parsed = BigInt(raw);
    return Number(parsed > 10_000_000_000n ? parsed / 1_000_000_000n : parsed);
  } catch {
    const parsed = safeNumber(raw, 0);
    if (!(parsed > 0)) return 0;
    return parsed > 1e15
      ? Math.floor(parsed / 1e9)
      : parsed > 1e12
        ? Math.floor(parsed / 1e3)
        : Math.floor(parsed);
  }
}

export function getAffiliateActionRouteVolumeUsd(action) {
  const inputPriceUsd = safeNumber(action?.metadata?.swap?.inPriceUSD, 0);
  if (!(inputPriceUsd > 0)) return 0;

  return (Array.isArray(action?.in) ? action.in : [])
    .flatMap((leg) => Array.isArray(leg?.coins) ? leg.coins : [])
    .reduce((sum, coin) => (
      sum + (safeNumber(coin?.amount, 0) / 1e8) * inputPriceUsd
    ), 0);
}

export function getAffiliateActionLegCount(action) {
  const pools = new Set(
    (Array.isArray(action?.pools) ? action.pools : [])
      .map(normalizeAsset)
      .filter(Boolean)
  );
  if (pools.size > 0) return pools.size;

  const inbound = firstCoin(action?.in);
  const outbound = firstCoin(action?.out, (leg) => !leg?.affiliate);
  const sourceAsset = normalizeAsset(inbound?.asset);
  const targetAsset = normalizeAsset(outbound?.asset);
  if (!sourceAsset || !targetAsset) return 1;
  return sourceAsset === RUNE_ASSET || targetAsset === RUNE_ASSET ? 1 : 2;
}

export function getAffiliateActionLegVolumeUsd(action) {
  return getAffiliateActionRouteVolumeUsd(action) * getAffiliateActionLegCount(action);
}

export function buildAffiliateTransactionRows(actions = [], {
  fromTimestamp,
  toTimestamp
} = {}) {
  const from = Math.max(0, Math.trunc(safeNumber(fromTimestamp, 0)));
  const to = Math.max(from, Math.trunc(safeNumber(toTimestamp, 0)));
  const rows = [];
  const seen = new Set();

  for (const action of Array.isArray(actions) ? actions : []) {
    const timestamp = midgardActionTimestampSeconds(action?.date);
    if (timestamp < from || timestamp >= to) continue;

    const inbound = firstCoin(action?.in);
    const outbound = firstCoin(action?.out, (leg) => !leg?.affiliate) ||
      action?.metadata?.swap?.streamingSwapMeta?.outCoin ||
      null;
    const txId = String(action?.in?.[0]?.txID || action?.txID || '').trim();
    if (!txId) continue;
    const identity = txId.toUpperCase();
    if (seen.has(identity)) continue;
    seen.add(identity);

    const swap = action?.metadata?.swap || {};
    const routeVolumeUsd = getAffiliateActionRouteVolumeUsd(action);
    const executedLegCount = getAffiliateActionLegCount(action);
    const inputAmount = safeNumber(inbound?.amount, 0) / 1e8;
    const startHeight = Math.max(0, Math.trunc(safeNumber(action?.height, 0)));
    const endHeight = actionEndHeight(action);

    rows.push({
      txId,
      dateMs: timestamp * 1000,
      startHeight,
      endHeight,
      status: String(action?.status || 'unknown').toLowerCase(),
      streaming: Boolean(swap?.isStreamingSwap) || endHeight > startHeight,
      inputAsset: String(inbound?.asset || ''),
      inputAmount,
      inputUsd: routeVolumeUsd,
      outputAsset: String(outbound?.asset || ''),
      outputAmount: safeNumber(outbound?.amount, 0) / 1e8,
      routeVolumeUsd,
      volumeUsd: routeVolumeUsd * executedLegCount,
      executedLegCount,
      liquidityFeeRune: safeNumber(swap?.liquidityFee, 0) / 1e8,
      reportedSwapSlipBps: safeNumber(swap?.swapSlip, 0),
      memo: String(swap?.memo || ''),
      volumeBasis: EXECUTED_LEG_VOLUME_BASIS,
      feeScope: 'whole-route'
    });
  }

  return rows.sort((left, right) => (
    right.volumeUsd - left.volumeUsd ||
    right.dateMs - left.dateMs ||
    left.txId.localeCompare(right.txId)
  ));
}

export function buildAffiliateLegVolumeSeries(actions = [], {
  fromTimestamp,
  toTimestamp
} = {}) {
  const from = Math.max(0, Math.trunc(safeNumber(fromTimestamp, 0)));
  const to = Math.max(from, Math.trunc(safeNumber(toTimestamp, 0)));
  const buckets = new Map();

  for (let startTime = from; startTime < to; startTime += DAY_SECONDS) {
    buckets.set(startTime, {
      startTime: String(startTime),
      endTime: String(Math.min(to, startTime + DAY_SECONDS)),
      legVolumeUsd: 0,
      routeVolumeUsd: 0,
      routeCount: 0,
      executedLegCount: 0
    });
  }

  for (const action of Array.isArray(actions) ? actions : []) {
    const timestamp = midgardActionTimestampSeconds(action?.date);
    if (timestamp < from || timestamp >= to) continue;
    const dayStart = Math.floor(timestamp / DAY_SECONDS) * DAY_SECONDS;
    const bucket = buckets.get(dayStart);
    if (!bucket) continue;

    const routeVolumeUsd = getAffiliateActionRouteVolumeUsd(action);
    const legCount = getAffiliateActionLegCount(action);
    bucket.routeVolumeUsd += routeVolumeUsd;
    bucket.legVolumeUsd += routeVolumeUsd * legCount;
    bucket.routeCount += 1;
    bucket.executedLegCount += legCount;
  }

  return [...buckets.values()].map((row) => ({
    ...row,
    volumeBasis: EXECUTED_LEG_VOLUME_BASIS
  }));
}
