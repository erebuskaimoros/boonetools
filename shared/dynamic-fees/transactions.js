const RUNE_ASSET = 'THOR.RUNE';

function parseInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function parseBaseAmount(value) {
  try {
    const normalized = String(value ?? '').trim();
    return /^\d+$/.test(normalized) ? BigInt(normalized) : 0n;
  } catch {
    return 0n;
  }
}

function normalizeAsset(asset) {
  return String(asset || '').trim().toUpperCase().replace('~', '.');
}

function normalizeTxId(txId) {
  return String(txId || '').trim().toUpperCase();
}

function firstCoin(legs = []) {
  for (const leg of Array.isArray(legs) ? legs : []) {
    if (Array.isArray(leg?.coins) && leg.coins[0]) return leg.coins[0];
  }
  return null;
}

function actionEndHeight(action) {
  const startHeight = parseInteger(action?.height);
  const streamingLastHeight = parseInteger(action?.metadata?.swap?.streamingSwapMeta?.lastHeight);
  return Math.max(startHeight, streamingLastHeight);
}

function midgardDateToMillis(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;

  try {
    return Number(BigInt(raw) / 1_000_000n);
  } catch (_) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 0;
    return parsed > 1e15 ? Math.floor(parsed / 1e6) : parsed > 1e12 ? parsed : parsed * 1000;
  }
}

function eventAttributes(event) {
  if (!event || typeof event !== 'object') return {};
  if (!Array.isArray(event.attributes)) return event;

  return Object.fromEntries(event.attributes.map((attribute) => [
    String(attribute?.key || ''),
    attribute?.value
  ]));
}

function parseEventCoin(value) {
  const match = String(value || '').trim().match(/^(\d+)\s+(.+)$/);
  if (!match) return { amount: 0n, asset: '' };
  return {
    amount: parseBaseAmount(match[1]),
    asset: normalizeAsset(match[2])
  };
}

export function calculateRealizedFeeBps(action) {
  const swap = action?.metadata?.swap || {};
  const liquidityFeeRuneBase = Number(swap?.liquidityFee || 0);
  if (!Number.isFinite(liquidityFeeRuneBase) || liquidityFeeRuneBase < 0) return null;
  if (liquidityFeeRuneBase === 0) return 0;

  const inbound = firstCoin(action?.in);
  const outbound = firstCoin(
    (Array.isArray(action?.out) ? action.out : []).filter((leg) => !leg?.affiliate)
  ) || swap?.streamingSwapMeta?.outCoin || null;

  if (normalizeAsset(inbound?.asset) === RUNE_ASSET) {
    const inputRuneBase = Number(inbound?.amount || 0);
    return inputRuneBase > 0 ? (liquidityFeeRuneBase / inputRuneBase) * 10000 : null;
  }

  if (normalizeAsset(outbound?.asset) === RUNE_ASSET) {
    const outputRuneBase = Number(outbound?.amount || 0);
    const grossRuneBase = outputRuneBase + liquidityFeeRuneBase;
    return grossRuneBase > 0 ? (liquidityFeeRuneBase / grossRuneBase) * 10000 : null;
  }

  const affiliateRuneBase = (Array.isArray(action?.out) ? action.out : [])
    .filter((leg) => leg?.affiliate)
    .flatMap((leg) => Array.isArray(leg?.coins) ? leg.coins : [])
    .filter((coin) => normalizeAsset(coin?.asset) === RUNE_ASSET)
    .reduce((sum, coin) => sum + Number(coin?.amount || 0), 0);
  const affiliateFeeBps = Number(swap?.affiliateFee || 0);

  return affiliateRuneBase > 0 && affiliateFeeBps > 0
    ? (liquidityFeeRuneBase / affiliateRuneBase) * affiliateFeeBps
    : null;
}

export function getEpochBlockRange(epoch, epochBlocks, {
  live = false,
  currentBlockHeight = 0
} = {}) {
  const normalizedEpoch = parseInteger(epoch);
  const normalizedEpochBlocks = parseInteger(epochBlocks);
  if (!normalizedEpoch || !normalizedEpochBlocks) return null;

  const startHeight = (normalizedEpoch - 1) * normalizedEpochBlocks + 1;
  const sealedEndHeight = normalizedEpoch * normalizedEpochBlocks;
  const liveEndHeight = Math.max(startHeight, parseInteger(currentBlockHeight));

  return {
    epoch: normalizedEpoch,
    live: Boolean(live),
    startHeight,
    endHeight: live ? Math.min(sealedEndHeight, liveEndHeight) : sealedEndHeight
  };
}

export function getPairFilterAsset(pair) {
  const assets = String(pair || '')
    .split('|')
    .map(normalizeAsset)
    .filter(Boolean);
  return assets.find((asset) => asset !== RUNE_ASSET) || assets[0] || '';
}

export function actionOverlapsRange(action, range) {
  if (!range) return false;
  const startHeight = parseInteger(action?.height);
  const endHeight = actionEndHeight(action);
  if (!startHeight || !endHeight) return false;
  return startHeight <= range.endHeight && endHeight >= range.startHeight;
}

export function actionMatchesPair(action, pair) {
  const filterAsset = getPairFilterAsset(pair);
  if (!filterAsset) return false;
  const pools = (Array.isArray(action?.pools) ? action.pools : []).map(normalizeAsset);
  return pools.includes(filterAsset);
}

export function extractSwapEvents(blockResults) {
  const result = blockResults?.result || blockResults || {};
  const blockEvents = [
    ...(Array.isArray(result.finalize_block_events) ? result.finalize_block_events : []),
    ...(Array.isArray(result.end_block_events) ? result.end_block_events : [])
  ];
  const transactionEvents = (Array.isArray(result.txs_results) ? result.txs_results : [])
    .flatMap((transaction) => Array.isArray(transaction?.events) ? transaction.events : []);

  return [...blockEvents, ...transactionEvents]
    .filter((event) => String(event?.type || '').toLowerCase() === 'swap');
}

export function calculatePairLegTotals(swapEvents = [], {
  pair = '',
  txId = '',
  memo = ''
} = {}) {
  const filterAsset = getPairFilterAsset(pair);
  const normalizedTxId = normalizeTxId(txId);
  const normalizedMemo = String(memo || '').trim();
  let feeRuneBase = 0n;
  let volumeRuneBase = 0n;
  let eventCount = 0;

  for (const event of Array.isArray(swapEvents) ? swapEvents : []) {
    if (String(event?.type || '').toLowerCase() !== 'swap') continue;
    const attributes = eventAttributes(event);
    if (normalizeAsset(attributes.pool) !== filterAsset) continue;
    if (normalizedTxId && normalizeTxId(attributes.id) !== normalizedTxId) continue;
    if (normalizedMemo && String(attributes.memo || '').trim() !== normalizedMemo) continue;

    const fee = parseBaseAmount(attributes.liquidity_fee_in_rune);
    const input = parseEventCoin(attributes.coin);
    const output = parseEventCoin(attributes.emit_asset);
    let volume = 0n;

    if (input.asset === RUNE_ASSET) {
      volume = input.amount;
    } else if (output.asset === RUNE_ASSET) {
      volume = output.amount + fee;
    } else {
      continue;
    }

    feeRuneBase += fee;
    volumeRuneBase += volume;
    eventCount += 1;
  }

  return {
    eventCount,
    feeRuneBase: feeRuneBase.toString(),
    volumeRuneBase: volumeRuneBase.toString(),
    realizedFeeBps: volumeRuneBase > 0n
      ? (Number(feeRuneBase) / Number(volumeRuneBase)) * 10000
      : null
  };
}

export function normalizeEpochTransactions(actions = [], {
  pair = '',
  range = null,
  pairLegTotalsByTxId = null
} = {}) {
  const rows = [];
  const seen = new Set();

  for (const action of Array.isArray(actions) ? actions : []) {
    if (!actionOverlapsRange(action, range) || !actionMatchesPair(action, pair)) continue;

    const inbound = firstCoin(action?.in);
    const outbound =
      firstCoin((Array.isArray(action?.out) ? action.out : []).filter((leg) => !leg?.affiliate)) ||
      action?.metadata?.swap?.streamingSwapMeta?.outCoin ||
      null;
    const txId = String(action?.in?.[0]?.txID || action?.txID || '').trim();
    const normalizedTxId = normalizeTxId(txId);
    if (!txId || seen.has(normalizedTxId)) continue;
    seen.add(normalizedTxId);

    const swap = action?.metadata?.swap || {};
    const inputAmount = Number(inbound?.amount || 0) / 1e8;
    const inputPriceUsd = Number(swap?.inPriceUSD || 0);
    const startHeight = parseInteger(action?.height);
    const endHeight = actionEndHeight(action);
    const routeLiquidityFeeRune = Number(swap?.liquidityFee || 0) / 1e8;
    const pairLegTotals = pairLegTotalsByTxId?.[normalizedTxId] || null;
    const hasExactPairLegTotals = Boolean(pairLegTotalsByTxId);

    rows.push({
      txId,
      dateMs: midgardDateToMillis(action?.date),
      startHeight,
      endHeight,
      status: String(action?.status || 'unknown').toLowerCase(),
      streaming: Boolean(swap?.isStreamingSwap),
      inputAsset: String(inbound?.asset || ''),
      inputAmount,
      inputUsd: inputAmount * inputPriceUsd,
      outputAsset: String(outbound?.asset || ''),
      outputAmount: Number(outbound?.amount || 0) / 1e8,
      liquidityFeeRune: pairLegTotals
        ? Number(pairLegTotals.feeRuneBase || 0) / 1e8
        : routeLiquidityFeeRune,
      pairVolumeRune: pairLegTotals
        ? Number(pairLegTotals.volumeRuneBase || 0) / 1e8
        : null,
      pairSwapEventCount: Number(pairLegTotals?.eventCount || 0),
      realizedFeeBps: hasExactPairLegTotals
        ? pairLegTotals?.realizedFeeBps ?? null
        : calculateRealizedFeeBps(action),
      feeScope: hasExactPairLegTotals ? 'selected_pair_epoch' : 'whole_route',
      memo: String(swap?.memo || '')
    });
  }

  return rows.sort((left, right) => (
    right.startHeight - left.startHeight ||
    right.dateMs - left.dateMs ||
    left.txId.localeCompare(right.txId)
  ));
}
