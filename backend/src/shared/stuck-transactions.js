import { createHash } from 'node:crypto';
import { TtlSingleFlightCache } from '../lib/ttl-cache.js';
import { extractThorHeight, fetchThorchain } from './thornode.js';
import {
  getThorNodeCoreSnapshot,
  isThorNodeCoreSnapshotStale
} from './thornode-core-snapshot.js';

const CACHE_TTL_MS = 30_000;
const STATUS_CONCURRENCY = 6;
const MARKET_SWAP_GRACE_BLOCKS = 300;

const snapshotCache = new TtlSingleFlightCache({ ttlMs: CACHE_TTL_MS });

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

    const scheduledHeight = numberValue(signedStage.scheduled_outbound_height);
    const overdueBlocks = scheduledHeight > 0 && currentHeight > 0
      ? Math.max(0, currentHeight - scheduledHeight)
      : numberValue(signedStage.blocks_since_scheduled);
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
      scheduled_height: scheduledHeight,
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

function lookupFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('base64url');
}

async function loadLookupCache(client, lookupType, fingerprints) {
  const values = new Map();
  const missing = [];
  if (!client?.query || fingerprints.size === 0) {
    return { values, missing: [...fingerprints.keys()] };
  }
  const hashes = [...fingerprints.keys()];
  const { rows } = await client.query(
    `select tx_id, queue_fingerprint, payload_json
     from stuck_transaction_lookup_cache
     where lookup_type = $1
       and tx_id = any($2::text[])`,
    [lookupType, hashes]
  );
  const byHash = new Map(rows.map((row) => [String(row.tx_id), row]));
  for (const hash of hashes) {
    const row = byHash.get(hash);
    if (row && row.queue_fingerprint === fingerprints.get(hash)) {
      values.set(hash, row.payload_json);
    } else {
      missing.push(hash);
    }
  }
  return { values, missing };
}

async function saveLookupCache(client, lookupType, fingerprints, values) {
  if (!client?.query || values.size === 0) return;
  const rows = [...values].map(([txId, payload]) => ({
    tx_id: txId,
    lookup_type: lookupType,
    queue_fingerprint: fingerprints.get(txId),
    payload_json: payload
  }));
  await client.query(
    `insert into stuck_transaction_lookup_cache (
       tx_id, lookup_type, queue_fingerprint, payload_json, fetched_at, updated_at
     )
     select row.tx_id, row.lookup_type, row.queue_fingerprint, row.payload_json, now(), now()
     from jsonb_to_recordset($1::jsonb) as row(
       tx_id text,
       lookup_type text,
       queue_fingerprint text,
       payload_json jsonb
     )
     on conflict (tx_id, lookup_type)
     do update set
       queue_fingerprint = excluded.queue_fingerprint,
       payload_json = excluded.payload_json,
       fetched_at = now(),
       updated_at = now()`,
    [JSON.stringify(rows)]
  );
}

async function loadIncrementalLookups(client, lookupType, hashes, fingerprints, endpoint, fetcher) {
  const cached = await loadLookupCache(client, lookupType, fingerprints);
  const fetched = await fetchByHash(cached.missing, endpoint, fetcher);
  await saveLookupCache(client, lookupType, fingerprints, fetched.values);
  return {
    values: new Map([...cached.values, ...fetched.values]),
    failures: fetched.failures,
    fetched: fetched.values.size,
    reused: cached.values.size
  };
}

function buildStatusFingerprints(hashes, outboundQueue, scheduledQueue, swapQueue) {
  const groupByHash = (rows, keyOf) => {
    const grouped = new Map();
    for (const row of rows) {
      const hash = String(keyOf(row) || '');
      if (!hash) continue;
      if (!grouped.has(hash)) grouped.set(hash, []);
      grouped.get(hash).push(row);
    }
    return grouped;
  };
  const outboundByHash = groupByHash(outboundQueue, (row) => row?.in_hash);
  const scheduledByHash = groupByHash(scheduledQueue, (row) => row?.in_hash);
  const swapsByHash = groupByHash(swapQueue, (row) => row?.tx?.id);
  return new Map(hashes.map((hash) => [hash, lookupFingerprint({
    outbound: outboundByHash.get(hash) || [],
    scheduled: scheduledByHash.get(hash) || [],
    swaps: swapsByHash.get(hash) || []
  })]));
}

function buildDetailsFingerprints(hashes, swapQueue) {
  const swapsByHash = new Map(
    swapQueue.map((row) => [String(row?.tx?.id || ''), row])
  );
  return new Map(hashes.map((hash) => [
    hash,
    lookupFingerprint(swapsByHash.get(hash) || null)
  ]));
}

export async function buildStuckTransactionSnapshot(fetcher = fetchThorchain, options = {}) {
  let coreSnapshot = options.coreSnapshot || null;
  let core = coreSnapshot?.payload || coreSnapshot || null;
  if (!core && options.client) {
    coreSnapshot = await (options.getThorNodeCoreSnapshot || getThorNodeCoreSnapshot)({
      client: options.client,
      allowStale: true,
      cache: false
    });
    core = coreSnapshot?.payload || null;
  }
  if (core && isThorNodeCoreSnapshotStale(coreSnapshot, [
    'lastblock', 'mimir', 'constants', 'inbound_addresses'
  ])) {
    throw new Error('Durable THORNode core snapshot is stale');
  }
  const [
    outboundQueueRaw,
    scheduledQueueRaw,
    swapQueuePayload,
    streamingSwapsRaw
  ] = await Promise.all([
    fetcher('/thorchain/queue/outbound'),
    fetcher('/thorchain/queue/scheduled'),
    fetcher('/thorchain/queue/swap/paginated?offset=0&limit=1000'),
    fetcher('/thorchain/swaps/streaming')
  ]);
  const [lastBlocks, mimir, constants, inboundAddresses] = core
    ? [core.lastblock, core.mimir, core.constants, core.inbound_addresses]
    : await Promise.all([
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

  const statusFingerprints = buildStatusFingerprints(
    statusHashes,
    outboundQueue,
    scheduledQueue,
    swapQueue
  );
  const detailsFingerprints = buildDetailsFingerprints(marketSwapIds, swapQueue);
  const [statusResult, detailsResult] = await Promise.all([
    loadIncrementalLookups(
      options.client,
      'status',
      statusHashes,
      statusFingerprints,
      '/thorchain/tx/status',
      fetcher
    ),
    loadIncrementalLookups(
      options.client,
      'details',
      marketSwapIds,
      detailsFingerprints,
      '/thorchain/tx/details',
      fetcher
    )
  ]);
  if (options.client?.query) {
    await options.client.query(
      `delete from stuck_transaction_lookup_cache
       where updated_at < now() - interval '24 hours'`
    ).catch(() => {});
  }
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
    failed_lookups: failures.length,
    lookups: {
      fetched: statusResult.fetched + detailsResult.fetched,
      reused: statusResult.reused + detailsResult.reused
    }
  };
}

export async function getStuckTransactionSnapshot() {
  return snapshotCache.getOrLoad('snapshot', buildStuckTransactionSnapshot, {
    staleIfError: true,
    onStale: (snapshot, error) => ({
      ...snapshot,
      stale: true,
      warning: `Serving the last successful stuck-transaction scan: ${error.message}`
    })
  });
}

export function resetStuckTransactionCache() {
  snapshotCache.clear();
}
