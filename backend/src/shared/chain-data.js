import { loadLatestChainHead } from './chain-headers.js';
import { coreSnapshotValue, getThorNodeCoreSnapshot } from './thornode-core-snapshot.js';
import { extractThorHeight } from './thornode.js';
import { fetchThorchainRpc } from './rpc.js';
import { acquireCached, loadAcquisition, saveAcquisition } from './acquisition-cache.js';

const BLOCK_TIME_NAMESPACE = 'thorchain-mainnet:block-time:v1';

function height(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function timestamp(value) {
  if (value == null || value === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export async function loadFreshThorchainHead(client, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const maxAgeMs = Math.max(1, Number(options.maxAgeMs) || 45_000);
  const fresh = (value) => {
    const time = Date.parse(value || '');
    return Number.isFinite(time) && time <= nowMs && nowMs - time <= maxAgeMs;
  };
  let head = null;
  try { head = await (options.loadHead || loadLatestChainHead)(client); } catch { /* Optional cache; retain RPC fallback. */ }
  const blockTime = timestamp(head?.time || head?.blockTime);
  if (height(head?.height) && fresh(blockTime)) {
    return { height: height(head.height), blockTime, observedAt: blockTime, source: 'chain-block-headers' };
  }
  let core = null;
  try { core = await (options.loadCore || getThorNodeCoreSnapshot)({ client, cache: false, allowStale: true }); }
  catch { /* Optional cache; retain RPC fallback. */ }
  const payload = core?.payload || core;
  const meta = payload?.field_meta?.lastblock;
  const coreHeight = height(extractThorHeight(coreSnapshotValue(core, 'lastblock', [])));
  if (coreHeight && !core?.stale && !payload?.stale && ['fresh', 'cached'].includes(meta?.status) && fresh(meta?.fetched_at)) {
    return { height: coreHeight, blockTime: height(head?.height) === coreHeight ? blockTime : null,
      observedAt: timestamp(meta.fetched_at), source: 'thornode-core:lastblock' };
  }
  return null;
}

export async function resolveThorchainHead(client, options = {}) {
  const cached = await loadFreshThorchainHead(client, options);
  if (cached) return cached;
  const result = options.fetchHead ? await options.fetchHead()
    : await fetchThorchainRpc('/status', {}, { cooldownClient: client, ...options.rpcOptions });
  const sync = result?.result?.sync_info || result?.sync_info;
  const resolvedHeight = height(result?.height ?? sync?.latest_block_height ?? result);
  if (!resolvedHeight) throw new Error('Provider returned an invalid THORChain head');
  return { height: resolvedHeight, blockTime: timestamp(result?.blockTime || sync?.latest_block_time),
    observedAt: timestamp(result?.observedAt) || new Date(options.nowMs ?? Date.now()).toISOString(),
    source: result?.source || 'thorchain-rpc:status' };
}

export async function loadStoredBlockTime(client, targetHeight) {
  const requested = height(targetHeight);
  if (!requested) throw new Error('Invalid THORChain block height');
  if (!client?.query) return null;
  const stored = await loadAcquisition(client, BLOCK_TIME_NAMESPACE, String(requested), { requireComplete: true });
  const cachedTime = height(stored?.payload?.height) === requested ? timestamp(stored?.payload?.blockTime) : null;
  if (cachedTime) return cachedTime;
  const { rows } = await client.query(
    `select height, block_time from chain_block_headers where height = $1 limit 1`, [requested]
  );
  const time = height(rows[0]?.height) === requested ? timestamp(rows[0]?.block_time) : null;
  if (time) {
    await saveAcquisition(client, { namespace: BLOCK_TIME_NAMESPACE, identity: String(requested),
      payload: { height: requested, blockTime: time }, source: 'chain-block-headers',
      completedAt: new Date().toISOString() });
    return time;
  }
  return null;
}

export async function resolveThorchainBlockTime(client, targetHeight, options = {}) {
  const requested = height(targetHeight);
  if (!requested) throw new Error('Invalid THORChain block height');
  const stored = await loadStoredBlockTime(client, requested);
  if (stored) return stored;
  const record = await acquireCached(client, {
    namespace: BLOCK_TIME_NAMESPACE, identity: String(requested), source: 'thorchain-rpc:block',
    immutable: true, nowMs: options.nowMs,
    validate: (payload) => payload?.height === requested && Boolean(timestamp(payload?.blockTime)),
    load: async (db) => {
      const result = options.fetchBlock ? await options.fetchBlock(requested)
        : await fetchThorchainRpc('/block', { height: requested }, { cooldownClient: db, ...options.rpcOptions });
      const header = result?.result?.block?.header || result?.block?.header || result?.header;
      if (height(header?.height) !== requested) throw new Error('Block response did not match the requested height');
      const blockTime = timestamp(header?.time);
      if (!blockTime || Date.parse(blockTime) > Number(options.nowMs ?? Date.now())) throw new Error('Block response has an invalid time');
      return { height: requested, blockTime };
    }
  });
  return record.payload.blockTime;
}
