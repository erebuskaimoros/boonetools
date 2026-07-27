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

function routeDue(previous, type, collectorKey, nowMs) {
  if (!['config', 'history'].includes(type)) return true;
  const fetchedAt = timestampMs(previous?.route_fetched_at?.[type]?.[collectorKey]);
  return fetchedAt <= 0 || nowMs - fetchedAt >= config.appLayerStaticStateTtlMs;
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
      .filter((type) => routeDue(previous, type, collector.key, nowMs))
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
      cooldownClient: client
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
