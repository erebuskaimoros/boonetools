import { withAdvisoryLock } from '../db/lock.js';
import { query } from '../db/pool.js';
import { config } from '../lib/config.js';
import { toIsoString } from '../lib/utils.js';
import { fetchThorchain } from './thornode.js';

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

async function smartConfig(address) {
  const payload = await fetchThorchain(
    `/cosmwasm/wasm/v1/contract/${address}/smart/${configQuery()}`
  );
  return payload.data || {};
}

async function smartActions(address) {
  const query = Buffer.from(JSON.stringify({ actions: {} })).toString('base64');
  const payload = await fetchThorchain(
    `/cosmwasm/wasm/v1/contract/${address}/smart/${query}`
  );
  return Array.isArray(payload.data?.actions) ? payload.data.actions : [];
}

async function contractBalances(address) {
  const payload = await fetchThorchain(`/cosmos/bank/v1beta1/balances/${address}`);
  return Array.isArray(payload?.balances) ? payload.balances : [];
}

async function contractHistory(address) {
  const payload = await fetchThorchain(`/cosmwasm/wasm/v1/contract/${address}/history`);
  return Array.isArray(payload.entries) ? payload.entries : [];
}

function normalizeRouteResult(type, collector, result) {
  if (result.status === 'fulfilled') {
    return {
      ok: true,
      key: collector.key,
      type,
      value: result.value
    };
  }

  return {
    ok: false,
    key: collector.key,
    type,
    error: result.reason?.message || 'unknown error'
  };
}

function buildObject(results) {
  return Object.fromEntries(
    results
      .filter((result) => result.ok)
      .map((result) => [result.key, result.value])
  );
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

export async function fetchAppLayerLiveStatePayload() {
  const startedAt = new Date().toISOString();
  const [network, pools, balanceResults, configResults, actionResults, historyResults] = await Promise.all([
    fetchThorchain('/thorchain/network'),
    fetchThorchain('/thorchain/pools'),
    Promise.allSettled(collectors.map((collector) => contractBalances(collector.address))),
    Promise.allSettled(collectors.map((collector) => smartConfig(collector.address))),
    Promise.allSettled(collectors.map((collector) => smartActions(collector.address))),
    Promise.allSettled(collectors.map((collector) => contractHistory(collector.address)))
  ]);

  const balanceRows = balanceResults.map((result, index) => (
    normalizeRouteResult('balance', collectors[index], result)
  ));
  const configRows = configResults.map((result, index) => (
    normalizeRouteResult('config', collectors[index], result)
  ));
  const actionRows = actionResults.map((result, index) => (
    normalizeRouteResult('actions', collectors[index], result)
  ));
  const historyRows = historyResults.map((result, index) => (
    normalizeRouteResult('history', collectors[index], result)
  ));
  const collectorBalances = buildObject(balanceRows);
  const failures = [...balanceRows, ...configRows, ...actionRows, ...historyRows]
    .filter((result) => !result.ok);

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
    const payload = await fetchAppLayerLiveStatePayload();
    const snapshot = await writeCachedSnapshot(client, payload);

    return {
      ok: true,
      refreshed: true,
      snapshot
    };
  });
}

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
