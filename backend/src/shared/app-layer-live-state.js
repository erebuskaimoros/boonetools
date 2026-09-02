import { withAdvisoryLock } from '../db/lock.js';
import { query } from '../db/pool.js';
import { config } from '../lib/config.js';
import { toIsoString } from '../lib/utils.js';
import { ANALYTICS_READ_MODEL_KEYS } from './analytics-read-model-keys.js';
import { getReadModel, publishReadModel } from './read-models.js';
import { fetchThorchain } from './thornode.js';
import {
  getThorNodeCoreSnapshot,
  isThorNodeCoreSnapshotStale
} from './thornode-core-snapshot.js';

// The v2 snapshot adds per-collector balances and conversion actions. Keep it
// separate from v1 so a cached pre-v2 response cannot be rendered as live
// inventory data.
const CACHE_KEY = 'app-layer-live-state:v2';
const LOCK_KEY = 'boonetools:app-layer-live-state';
const BASE_LAYER_COLLECTOR =
  'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr';

const collectors = Object.freeze([
  {
    key: 'trade',
    address: 'thor1gm8q2gr25nzzsxzdp2mpja4hyvyhjlr4s6krcsgv2y953uu0js3qhwpus7'
  },
  {
    key: 'core',
    address: 'thor1jduxxzpyyvrgzx7zcnl7e5cdj34tnq5jxy00a4wp86szye25dndq575c0y'
  },
  {
    key: 'swap',
    address: 'thor1mcy9jtp4kzl8q2lvdgfgsl8jvqrf504uphkf0pz2p9wud8tsntesjvccew'
  },
  {
    key: 'index',
    address: 'thor132u9qpm9gfdqtgwxwl8ty409s6zmewfrum2k6wvtvtyphdn5urzsej764l'
  },
  {
    key: 'base',
    address: BASE_LAYER_COLLECTOR
  }
]);

function configQuery() {
  return Buffer.from(JSON.stringify({ config: {} })).toString('base64');
}

async function smartConfig(address, fetchThor = fetchThorchain) {
  const payload = await fetchThor(
    `/cosmwasm/wasm/v1/contract/${address}/smart/${configQuery()}`
  );
  return payload.data || {};
}

async function smartActions(address, fetchThor = fetchThorchain) {
  const query = Buffer.from(JSON.stringify({ actions: {} })).toString('base64');
  const payload = await fetchThor(
    `/cosmwasm/wasm/v1/contract/${address}/smart/${query}`
  );
  return Array.isArray(payload.data?.actions) ? payload.data.actions : [];
}

async function contractBalances(address, fetchThor = fetchThorchain) {
  const payload = await fetchThor(`/cosmos/bank/v1beta1/balances/${address}`);
  return Array.isArray(payload?.balances) ? payload.balances : [];
}

async function contractHistory(address, fetchThor = fetchThorchain) {
  const payload = await fetchThor(`/cosmwasm/wasm/v1/contract/${address}/history`);
  return Array.isArray(payload.entries) ? payload.entries : [];
}

function buildObject(results) {
  return Object.fromEntries(
    results
      .filter((result) => result.ok)
      .map((result) => [result.key, result.value])
  );
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, Math.trunc(concurrency) || 1), items.length) },
    run
  ));
  return results;
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function collectorCoverageHealthy(state, nowMs) {
  const blockTime = timestampMs(state?.last_block_time);
  return Number(state?.contiguous_blocks) >= 2 && Number(state?.last_height) > 0
    && blockTime > 0 && blockTime <= nowMs && nowMs - blockTime <= 45000;
}

function eventVersion(state, key) {
  return `${Number(state?.generation) || 0}:${Number(state?.dirty_heights?.[key]) || 0}`;
}

function previousEventVersion(previous, type, key) {
  return previous?.route_event_versions?.[type]?.[key]
    || (previous?.collector_invalidation
      ? `${Number(previous.collector_invalidation.generation) || 0}:${Number(previous.route_invalidation?.[key]?.[type]) || 0}` : '');
}

function routeDue(previous, type, collectorKey, nowMs, invalidation) {
  if (type === 'balance') return true;
  const healthy = collectorCoverageHealthy(invalidation, nowMs);
  if (type === 'actions' && !healthy) return true;
  if (['actions', 'history'].includes(type) && healthy
    && previousEventVersion(previous, type, collectorKey) !== eventVersion(invalidation, collectorKey)) return true;
  const ttlMs = type === 'history' && healthy ? 24 * 60 * 60 * 1000 : config.appLayerStaticStateTtlMs;
  const fetchedAt = timestampMs(previous?.route_fetched_at?.[type]?.[collectorKey]);
  return fetchedAt <= 0 || fetchedAt > nowMs || nowMs - fetchedAt >= ttlMs;
}

export function collectorBlockInvalidation(data = {}) {
  const finalize = data.result_finalize_block || data.result_end_block;
  const txResults = finalize?.tx_results ?? finalize?.txs_results;
  const blockTxs = data.block?.data?.txs;
  const events = [...(Array.isArray(finalize?.events) ? finalize.events : [])];
  const txEventsComplete = Array.isArray(txResults)
    && txResults.every((tx) => Number(tx?.code || 0) !== 0 || Array.isArray(tx?.events));
  const complete = Array.isArray(finalize?.events) && txEventsComplete
    && (!Array.isArray(blockTxs) || blockTxs.length === txResults.length);
  for (const tx of Array.isArray(txResults) ? txResults : []) {
    if (Number(tx?.code || 0) === 0 && Array.isArray(tx.events)) events.push(...tx.events);
  }
  const byAddress = new Map(collectors.map((collector) => [collector.address, collector.key]));
  const dirty = new Set();
  const decode = (value) => {
    const text = String(value || '');
    if (text.startsWith('thor1') || text.includes('contract')) return text;
    try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return text; }
  };
  for (const event of events) {
    // wasmd emits generic sudo/migrate events even when a privileged mutation
    // returns no custom attributes. Execute/custom wasm events conservatively
    // invalidate other deployed collector versions as well.
    if (!/^(sudo|migrate|instantiate|execute|wasm(?:-|$)|update_contract_)/.test(String(event?.type || ''))) continue;
    for (const attribute of event.attributes || []) {
      if (!['_contract_address', 'contract_address', 'contract'].includes(decode(attribute.key))) continue;
      const key = byAddress.get(decode(attribute.value));
      if (key) dirty.add(key);
    }
  }
  return { height: Number(data.block?.header?.height) || 0,
    blockTime: data.block?.header?.time || null, complete, dirty: [...dirty] };
}

export async function recordCollectorEventBlock(client, data) {
  const block = collectorBlockInvalidation(data);
  if (block.height <= 0 || !timestampMs(block.blockTime)) return;
  const dirty = Object.fromEntries(block.dirty.map((key) => [key, block.height]));
  await client.query(
    `insert into app_layer_collector_event_state as current
       (stream_key, last_height, last_block_time, generation, contiguous_blocks, dirty_heights)
     values ('thorchain-mainnet', $1, $2, 1, case when $3 then 1 else 0 end, $4::jsonb)
     on conflict (stream_key) do update set
       last_height = excluded.last_height,
       last_block_time = excluded.last_block_time,
       generation = current.generation + case when $3 and excluded.last_height = current.last_height + 1 then 0 else 1 end,
       contiguous_blocks = case when $3 and excluded.last_height = current.last_height + 1
         then least(2, current.contiguous_blocks + 1) when $3 then 1 else 0 end,
       dirty_heights = current.dirty_heights || excluded.dirty_heights,
       updated_at = now()
     where excluded.last_height > current.last_height`,
    [block.height, block.blockTime, block.complete, JSON.stringify(dirty)]
  );
}

export async function resetCollectorEventCoverage(client) {
  await client.query(`update app_layer_collector_event_state
    set contiguous_blocks = 0, generation = generation + 1, updated_at = now()
    where stream_key = 'thorchain-mainnet'`);
}

async function loadCollectorInvalidation(client) {
  const { rows } = await client.query(`select last_height, last_block_time, generation, contiguous_blocks, dirty_heights
    from app_layer_collector_event_state where stream_key = 'thorchain-mainnet'`);
  return rows[0] || null;
}

function routeWarning(failures) {
  if (!failures.length) {
    return '';
  }

  return `${failures.length} route queries failed on backend: ${failures[0].error}`;
}

function normalizeCachedRow(row) {
  if (!row) {
    return null;
  }

  const expiresAtMs = Date.parse(String(row.expires_at || ''));
  const stale = !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
  const payload = row.payload_json || {};

  return {
    ...payload,
    fetched_at: toIsoString(row.fetched_at),
    expires_at: toIsoString(row.expires_at),
    stale
  };
}

async function readCachedSnapshot(client = { query }) {
  const { rows } = await client.query(
    `select payload_json, fetched_at, expires_at
     from api_response_cache
     where cache_key = $1
     limit 1`,
    [CACHE_KEY]
  );

  return normalizeCachedRow(rows[0] || null);
}

async function writeCachedSnapshot(client, payload) {
  const expiresAt = new Date(Date.now() + config.appLayerLiveStateTtlMs).toISOString();
  await client.query(
    `insert into api_response_cache (cache_key, payload_json, fetched_at, expires_at)
     values ($1, $2, now(), $3)
     on conflict (cache_key)
     do update set
       payload_json = excluded.payload_json,
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
    [CACHE_KEY, payload, expiresAt]
  );

  return {
    ...payload,
    fetched_at: new Date().toISOString(),
    expires_at: expiresAt,
    stale: false
  };
}

export async function fetchAppLayerLiveStatePayload(options = {}) {
  const now = typeof options.now === 'function' ? options.now() : new Date();
  const startedAt = now.toISOString();
  const nowMs = now.getTime();
  const previous = options.previousSnapshot || null;
  const invalidation = options.collectorInvalidation || null;
  const core = options.coreSnapshot?.payload || options.coreSnapshot || null;
  const coreStale = isThorNodeCoreSnapshotStale(options.coreSnapshot, ['network', 'pools']);
  const fetchThor = options.fetchThorchain || ((path) => fetchThorchain(path, {
    cooldownClient: options.cooldownClient
  }));
  let network;
  let pools;
  if (core) {
    if (coreStale || !core.network || !Array.isArray(core.pools)) {
      throw new Error('Durable THORNode core snapshot is stale or incomplete');
    }
    network = core.network;
    pools = core.pools;
  } else {
    [network, pools] = await Promise.all([
      fetchThor('/thorchain/network'),
      fetchThor('/thorchain/pools')
    ]);
  }

  const routeLoaders = {
    balance: contractBalances,
    config: smartConfig,
    actions: smartActions,
    history: contractHistory
  };
  const tasks = collectors.flatMap((collector) => (
    Object.keys(routeLoaders)
      .filter((type) => routeDue(previous, type, collector.key, nowMs, invalidation))
      .map((type) => ({ type, collector }))
  ));
  const loaded = await mapWithConcurrency(
    tasks,
    options.routeConcurrency || config.appLayerRouteConcurrency,
    async ({ type, collector }) => {
      try {
        const value = await routeLoaders[type](collector.address, fetchThor);
        return { ok: true, key: collector.key, type, value };
      } catch (error) {
        return { ok: false, key: collector.key, type, error: error.message || 'unknown error' };
      }
    }
  );
  const loadedByRoute = new Map(loaded.map((result) => [`${result.type}:${result.key}`, result]));
  const rowsForType = (type, previousKey) => collectors.map((collector) => {
    const result = loadedByRoute.get(`${type}:${collector.key}`);
    if (result?.ok) return result;
    const previousValue = previous?.[previousKey]?.[collector.key];
    if (previousValue !== undefined) {
      return {
        ok: true,
        key: collector.key,
        type,
        value: previousValue,
        reused: true,
        error: result?.error || ''
      };
    }
    return result || { ok: false, key: collector.key, type, error: 'route data is unavailable' };
  });
  const balanceRows = rowsForType('balance', 'collector_balances');
  const configRows = rowsForType('config', 'configs');
  const actionRows = rowsForType('actions', 'actions');
  const historyRows = rowsForType('history', 'histories');
  const collectorBalances = buildObject(balanceRows);
  const failures = [...balanceRows, ...configRows, ...actionRows, ...historyRows]
    .filter((result) => !result.ok || result.error);
  const routeFetchedAt = Object.fromEntries(Object.keys(routeLoaders).map((type) => [
    type,
    Object.fromEntries(collectors.map((collector) => {
      const result = loadedByRoute.get(`${type}:${collector.key}`);
      return [
        collector.key,
        result?.ok ? startedAt : previous?.route_fetched_at?.[type]?.[collector.key] || null
      ];
    }))
  ]));

  return {
    schema_version: 2,
    source: 'boonetools-backend',
    as_of: startedAt,
    network,
    pools: Array.isArray(pools) ? pools : [],
    // Preserve the original Base collector field for existing API consumers.
    balances: collectorBalances.base || [],
    collector_balances: collectorBalances,
    configs: buildObject(configRows),
    actions: buildObject(actionRows),
    histories: buildObject(historyRows),
    route_fetched_at: routeFetchedAt,
    collector_invalidation: invalidation,
    route_event_versions: Object.fromEntries(['actions', 'history'].map((type) => [type,
      Object.fromEntries(collectors.map((collector) => [collector.key,
        loadedByRoute.get(`${type}:${collector.key}`)?.ok
          ? eventVersion(invalidation, collector.key)
          : previousEventVersion(previous, type, collector.key)
      ]))
    ])),
    route_query_failures: failures.map((failure) => ({
      key: failure.key,
      type: failure.type,
      error: failure.error
    })),
    warning: routeWarning(failures)
  };
}

export async function refreshAppLayerLiveState() {
  return withAdvisoryLock(LOCK_KEY, async (client) => {
    const cachedPrevious = await readCachedSnapshot(client);
    const previousModel = cachedPrevious ? null : await getReadModel(
      ANALYTICS_READ_MODEL_KEYS.appLayerLiveState,
      { client, allowStale: true, cache: false }
    );
    const previous = cachedPrevious || previousModel?.payload || null;
    const coreModel = await getThorNodeCoreSnapshot({
      client,
      allowStale: true,
      cache: false
    });
    if (!coreModel) throw new Error('Durable THORNode core snapshot is not available');
    const payload = await fetchAppLayerLiveStatePayload({
      previousSnapshot: previous,
      coreSnapshot: coreModel,
      cooldownClient: client,
      collectorInvalidation: await loadCollectorInvalidation(client)
    });
    const snapshot = await writeCachedSnapshot(client, payload);
    await publishReadModel(ANALYTICS_READ_MODEL_KEYS.appLayerLiveState, snapshot, {
      client,
      ttlMs: Math.max(config.appLayerLiveStateTtlMs, 5 * 60 * 1000),
      schemaVersion: 1,
      generatedAt: payload.as_of,
      sourceUpdatedAt: payload.as_of,
      metadata: {
        route_query_failures: payload.route_query_failures?.length || 0
      }
    });

    return {
      ok: true,
      refreshed: true,
      snapshot
    };
  });
}

export const refreshAppLayerLiveStateReadModel = refreshAppLayerLiveState;

export async function getAppLayerLiveState() {
  const cached = await readCachedSnapshot();
  if (cached && !cached.stale) {
    return cached;
  }

  try {
    const refreshResult = await refreshAppLayerLiveState();
    if (refreshResult?.snapshot) {
      return refreshResult.snapshot;
    }
  } catch (refreshError) {
    if (cached) {
      return {
        ...cached,
        stale: true,
        warning: cached.warning || `Serving stale app-layer live state: ${refreshError.message}`
      };
    }

    throw refreshError;
  }

  if (cached) {
    return {
      ...cached,
      stale: true,
      warning: cached.warning || 'Serving stale app-layer live state while refresh is running'
    };
  }

  throw new Error('App-layer live state is not cached yet');
}
