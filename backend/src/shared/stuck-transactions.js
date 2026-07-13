import { extractThorHeight, fetchThorchain } from './thornode.js';

const CACHE_TTL_MS = 30_000;
const STATUS_CONCURRENCY = 6;
const MARKET_SWAP_GRACE_BLOCKS = 300;

let cachedSnapshot = null;
let cachedAt = 0;
let refreshPromise = null;

function numberValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function mimirMap(mimir = {}) {
  return new Map(
    Object.entries(mimir || {}).map(([key, value]) => [String(key).toUpperCase(), value])
  );
}

function configValue(mimirByKey, constants, mimirKey, constantKey, fallback) {
  const override = Number(mimirByKey.get(mimirKey));
  if (Number.isFinite(override) && override >= 0) {
    return override;
  }

  const constant = Number(constants?.int_64_values?.[constantKey]);
  return Number.isFinite(constant) ? constant : fallback;
}

function isHeightMimirActive(value, currentHeight) {
  const activationHeight = numberValue(value);
  return activationHeight > 0 && activationHeight <= currentHeight;
}

function isNodePauseActive(mimirByKey, currentHeight) {
  const pauseUntil = numberValue(mimirByKey.get('NODEPAUSECHAINGLOBAL'));
  return currentHeight > 0 && pauseUntil >= currentHeight;
}

function isFullChainHaltActive(chain, mimirByKey, currentHeight) {
  return Boolean(
    isHeightMimirActive(mimirByKey.get('HALTCHAINGLOBAL'), currentHeight) ||
    isNodePauseActive(mimirByKey, currentHeight) ||
    isHeightMimirActive(mimirByKey.get(`HALT${chain}CHAIN`), currentHeight) ||
    isHeightMimirActive(mimirByKey.get(`SOLVENCYHALT${chain}CHAIN`), currentHeight)
  );
}

function isSigningHalted(chain, mimirByKey, currentHeight) {
  return Boolean(
    isFullChainHaltActive(chain, mimirByKey, currentHeight) ||
    isHeightMimirActive(mimirByKey.get('HALTSIGNING'), currentHeight) ||
    isHeightMimirActive(mimirByKey.get(`HALTSIGNING${chain}`), currentHeight)
  );
}

function isTradingHalted(chain, mimirByKey, currentHeight, inboundByChain) {
  const inbound = inboundByChain.get(chain);
  return Boolean(
    inbound?.halted ||
    inbound?.global_trading_paused ||
    inbound?.chain_trading_paused ||
    isFullChainHaltActive(chain, mimirByKey, currentHeight) ||
    isHeightMimirActive(mimirByKey.get('HALTTRADING'), currentHeight) ||
    isHeightMimirActive(mimirByKey.get(`HALT${chain}TRADING`), currentHeight)
  );
}

function chainFromAsset(asset) {
  return String(asset || '').split(/[.~]/, 1)[0].toUpperCase();
}

function assetTicker(asset) {
  const layerOne = String(asset || '').split(/[.~]/).slice(1).join('.') || String(asset || '');
  return layerOne.split('-')[0] || layerOne;
}

function paymentKey(chain, toAddress, coin) {
  if (!chain || !toAddress || !coin?.asset || coin?.amount == null) return '';
  return [
    String(chain).toUpperCase(),
    String(toAddress),
    String(coin.asset).toUpperCase(),
    String(coin.amount)
  ].join('|');
}

function outstandingObligations(status) {
  const remainingByKey = new Map();
  const plannedByKey = new Map();

  for (const planned of status?.planned_out_txs || []) {
    const key = paymentKey(planned.chain, planned.to_address, planned.coin);
    if (!key) continue;
    remainingByKey.set(key, (remainingByKey.get(key) || 0) + 1);
    if (!plannedByKey.has(key)) plannedByKey.set(key, planned);
  }

  for (const outbound of status?.out_txs || []) {
    for (const coin of outbound?.coins || []) {
      const key = paymentKey(outbound.chain, outbound.to_address, coin);
      const remaining = remainingByKey.get(key) || 0;
      if (remaining > 0) remainingByKey.set(key, remaining - 1);
    }
  }

  return { remainingByKey, plannedByKey };
}

function hasRealOutboundHash(value) {
  const hash = String(value || '').trim();
  return Boolean(hash && !/^0+$/.test(hash));
}

function statusFor(statusByHash, hash) {
  return statusByHash instanceof Map ? statusByHash.get(hash) : statusByHash?.[hash];
}

function buildOutstandingOutboundRows({
  queue,
  queueStage,
  statusByHash,
  mimirByKey,
  currentHeight,
  signingGraceBlocks
}) {
  const rows = [];

  for (const item of queue || []) {
    const txId = String(item?.in_hash || '');
    const chain = String(item?.chain || '').toUpperCase();
    const status = statusFor(statusByHash, txId);
    const signedStage = status?.stages?.outbound_signed;
    if (!txId || !chain || !status || !signedStage) continue;
    if (status?.stages?.inbound_finalised?.completed !== true) continue;
    if (signedStage.completed || hasRealOutboundHash(item.out_hash)) continue;
    if (isSigningHalted(chain, mimirByKey, currentHeight)) continue;

    const overdueBlocks = numberValue(signedStage.blocks_since_scheduled);
    if (overdueBlocks <= signingGraceBlocks) continue;

    const key = paymentKey(chain, item.to_address, item.coin);
    const { remainingByKey, plannedByKey } = outstandingObligations(status);
    if (!key || (remainingByKey.get(key) || 0) <= 0) continue;

    const planned = plannedByKey.get(key);
    rows.push({
      tx_id: txId,
      stage: queueStage,
      stage_label: planned?.refund ? 'Refund signing' : 'Outbound signing',
      chain,
      asset: String(item.coin?.asset || ''),
      asset_ticker: assetTicker(item.coin?.asset),
      amount: String(item.coin?.amount || '0'),
      destination: String(item.to_address || ''),
      scheduled_height: numberValue(signedStage.scheduled_outbound_height),
      overdue_blocks: overdueBlocks,
      retry_height: numberValue(item.height),
      completed_outbounds: (status.out_txs || []).length,
      refund: Boolean(planned?.refund)
    });
  }

  return rows;
}

function buildStalledStreamingRows({
  streamingSwaps,
  limitSwapIds,
  mimirByKey,
  constants,
  currentHeight,
  inboundByChain
}) {
  const streamingPaused = configValue(
    mimirByKey,
    constants,
    'STREAMINGSWAPPAUSE',
    'StreamingSwapPause',
    0
  ) > 0;
  if (streamingPaused) return [];

  return (streamingSwaps || []).flatMap((swap) => {
    const txId = String(swap?.tx_id || '');
    const sourceChain = chainFromAsset(swap?.source_asset);
    const targetChain = chainFromAsset(swap?.target_asset);
    const quantity = numberValue(swap?.quantity);
    const count = numberValue(swap?.count);
    const interval = Math.max(1, numberValue(swap?.interval));
    const lastHeight = numberValue(swap?.last_height);
    if (!txId || limitSwapIds.has(txId) || quantity <= 0 || count >= quantity || lastHeight <= 0) {
      return [];
    }
    if (
      isTradingHalted(sourceChain, mimirByKey, currentHeight, inboundByChain) ||
      isTradingHalted(targetChain, mimirByKey, currentHeight, inboundByChain)
    ) {
      return [];
    }

    const overdueBlocks = Math.max(0, currentHeight - lastHeight);
    const progressGraceBlocks = Math.max(3 * interval, MARKET_SWAP_GRACE_BLOCKS);
    if (overdueBlocks <= progressGraceBlocks) return [];

    return [{
      tx_id: txId,
      stage: 'streaming_swap',
      stage_label: 'Streaming swap',
      chain: targetChain,
      asset: String(swap.target_asset || ''),
      asset_ticker: assetTicker(swap.target_asset),
      amount: String(swap.trade_target || '0'),
      destination: String(swap.destination || ''),
      scheduled_height: lastHeight + interval,
      overdue_blocks: overdueBlocks,
      retry_height: 0,
      completed_outbounds: 0,
      progress: { count, quantity, interval }
    }];
  });
}

function buildStalledMarketRows({
  swapQueue,
  streamingIds,
  statusByHash,
  detailsByHash,
  mimirByKey,
  currentHeight,
  inboundByChain
}) {
  return (swapQueue || []).flatMap((swap) => {
    const txId = String(swap?.tx?.id || '');
    if (!txId || swap?.swap_type === 'limit' || streamingIds.has(txId)) return [];

    const status = statusFor(statusByHash, txId);
    const details = statusFor(detailsByHash, txId);
    const sourceChain = chainFromAsset(swap?.tx?.coins?.[0]?.asset);
    const targetChain = chainFromAsset(swap?.target_asset);
    if (!status || !details || status?.stages?.inbound_finalised?.completed !== true) return [];
    if (status?.stages?.swap_status?.pending !== true || (status.out_txs || []).length > 0) return [];
    if (
      isTradingHalted(sourceChain, mimirByKey, currentHeight, inboundByChain) ||
      isTradingHalted(targetChain, mimirByKey, currentHeight, inboundByChain)
    ) {
      return [];
    }

    const consensusHeight = numberValue(details.consensus_height);
    const overdueBlocks = consensusHeight > 0 ? currentHeight - consensusHeight : 0;
    if (overdueBlocks <= MARKET_SWAP_GRACE_BLOCKS) return [];

    return [{
      tx_id: txId,
      stage: 'market_swap',
      stage_label: 'Market swap',
      chain: targetChain,
      asset: String(swap.target_asset || ''),
      asset_ticker: assetTicker(swap.target_asset),
      amount: String(swap.trade_target || '0'),
      destination: String(swap.destination || ''),
      scheduled_height: consensusHeight,
      overdue_blocks: overdueBlocks,
      retry_height: 0,
      completed_outbounds: 0
    }];
  });
}

export function classifyStuckTransactions({
  outboundQueue = [],
  scheduledQueue = [],
  swapQueue = [],
  streamingSwaps = [],
  statuses = new Map(),
  details = new Map(),
  mimir = {},
  constants = {},
  lastBlocks = [],
  inboundAddresses = []
} = {}) {
  const currentHeight = extractThorHeight(lastBlocks);
  const mimirByKey = mimirMap(mimir);
  const inboundByChain = new Map(
    (inboundAddresses || []).map((row) => [String(row?.chain || '').toUpperCase(), row])
  );
  const signingGraceBlocks = (
    configValue(mimirByKey, constants, 'SIGNINGTRANSACTIONPERIOD', 'SigningTransactionPeriod', 300) +
    configValue(mimirByKey, constants, 'OBSERVATIONDELAYFLEXIBILITY', 'ObservationDelayFlexibility', 10)
  );
  const limitSwapIds = new Set(
    (swapQueue || []).filter((swap) => swap?.swap_type === 'limit').map((swap) => String(swap?.tx?.id || ''))
  );
  const streamingIds = new Set((streamingSwaps || []).map((swap) => String(swap?.tx_id || '')));

  const rows = [
    ...buildOutstandingOutboundRows({
      queue: outboundQueue,
      queueStage: 'outbound_signing',
      statusByHash: statuses,
      mimirByKey,
      currentHeight,
      signingGraceBlocks
    }),
    ...buildOutstandingOutboundRows({
      queue: scheduledQueue,
      queueStage: 'scheduled_outbound',
      statusByHash: statuses,
      mimirByKey,
      currentHeight,
      signingGraceBlocks
    }),
    ...buildStalledStreamingRows({
      streamingSwaps,
      limitSwapIds,
      mimirByKey,
      constants,
      currentHeight,
      inboundByChain
    }),
    ...buildStalledMarketRows({
      swapQueue,
      streamingIds,
      statusByHash: statuses,
      detailsByHash: details,
      mimirByKey,
      currentHeight,
      inboundByChain
    })
  ];

  const unique = new Map();
  for (const row of rows) {
    const key = `${row.tx_id}:${row.stage}:${row.chain}:${row.asset}:${row.amount}:${row.destination}`;
    const previous = unique.get(key);
    if (!previous || row.overdue_blocks > previous.overdue_blocks) unique.set(key, row);
  }

  return {
    currentHeight,
    signingGraceBlocks,
    transactions: [...unique.values()].sort((left, right) => (
      right.overdue_blocks - left.overdue_blocks || left.tx_id.localeCompare(right.tx_id)
    ))
  };
}

async function fetchByHash(hashes, endpoint, fetcher) {
  const uniqueHashes = [...new Set(hashes.filter(Boolean))];
  const values = new Map();
  const failures = [];
  let cursor = 0;

  async function worker() {
    while (cursor < uniqueHashes.length) {
      const hash = uniqueHashes[cursor];
      cursor += 1;
      try {
        values.set(hash, await fetcher(`${endpoint}/${encodeURIComponent(hash)}`));
      } catch (error) {
        failures.push({ tx_id: hash, error: error.message || String(error) });
      }
    }
  }

  const workerCount = Math.min(STATUS_CONCURRENCY, uniqueHashes.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { values, failures };
}

export async function buildStuckTransactionSnapshot(fetcher = fetchThorchain) {
  const [
    outboundQueueRaw,
    scheduledQueueRaw,
    swapQueuePayload,
    streamingSwapsRaw,
    lastBlocks,
    mimir,
    constants,
    inboundAddresses
  ] = await Promise.all([
    fetcher('/thorchain/queue/outbound'),
    fetcher('/thorchain/queue/scheduled'),
    fetcher('/thorchain/queue/swap/paginated?offset=0&limit=1000'),
    fetcher('/thorchain/swaps/streaming'),
    fetcher('/thorchain/lastblock'),
    fetcher('/thorchain/mimir'),
    fetcher('/thorchain/constants'),
    fetcher('/thorchain/inbound_addresses')
  ]);

  const outboundQueue = Array.isArray(outboundQueueRaw) ? outboundQueueRaw : [];
  const scheduledQueue = Array.isArray(scheduledQueueRaw) ? scheduledQueueRaw : [];
  const swapQueue = Array.isArray(swapQueuePayload?.swap_queue) ? swapQueuePayload.swap_queue : [];
  const streamingSwaps = Array.isArray(streamingSwapsRaw) ? streamingSwapsRaw : [];
  const streamingIds = new Set(streamingSwaps.map((swap) => String(swap?.tx_id || '')));
  const marketSwapIds = swapQueue
    .filter((swap) => swap?.swap_type !== 'limit' && !streamingIds.has(String(swap?.tx?.id || '')))
    .map((swap) => String(swap?.tx?.id || ''))
    .filter(Boolean);
  const queueHashes = [...outboundQueue, ...scheduledQueue]
    .map((item) => String(item?.in_hash || ''))
    .filter(Boolean);
  const statusHashes = [...queueHashes, ...marketSwapIds];

  const [statusResult, detailsResult] = await Promise.all([
    fetchByHash(statusHashes, '/thorchain/tx/status', fetcher),
    fetchByHash(marketSwapIds, '/thorchain/tx/details', fetcher)
  ]);
  const classified = classifyStuckTransactions({
    outboundQueue,
    scheduledQueue,
    swapQueue,
    streamingSwaps,
    statuses: statusResult.values,
    details: detailsResult.values,
    mimir,
    constants,
    lastBlocks,
    inboundAddresses
  });
  const failures = [...statusResult.failures, ...detailsResult.failures];

  return {
    scanned_at: new Date().toISOString(),
    height: classified.currentHeight,
    transactions: classified.transactions,
    count: new Set(classified.transactions.map((row) => row.tx_id)).size,
    criteria: {
      signing_grace_blocks: classified.signingGraceBlocks,
      market_swap_grace_blocks: MARKET_SWAP_GRACE_BLOCKS,
      streaming_progress_grace: 'max(3 × interval, 300 blocks)'
    },
    queues: {
      outbound: outboundQueue.length,
      scheduled: scheduledQueue.length,
      swaps: swapQueue.length,
      streaming: streamingSwaps.length
    },
    partial: failures.length > 0,
    failed_lookups: failures.length
  };
}

export async function getStuckTransactionSnapshot() {
  const now = Date.now();
  if (cachedSnapshot && (now - cachedAt) < CACHE_TTL_MS) return cachedSnapshot;
  if (refreshPromise) return refreshPromise;

  refreshPromise = buildStuckTransactionSnapshot()
    .then((snapshot) => {
      cachedSnapshot = snapshot;
      cachedAt = Date.now();
      return snapshot;
    })
    .catch((error) => {
      if (cachedSnapshot) {
        return {
          ...cachedSnapshot,
          stale: true,
          warning: `Serving the last successful stuck-transaction scan: ${error.message}`
        };
      }
      throw error;
    })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

export function resetStuckTransactionCache() {
  cachedSnapshot = null;
  cachedAt = 0;
  refreshPromise = null;
}
