import { fetchThorchainRpc } from './rpc.js';
import { fetchThorchain } from './thornode.js';

function positiveHeight(value) {
  const height = Math.trunc(Number(value));
  if (!Number.isFinite(height) || height <= 0) throw new Error(`Invalid THORChain height: ${value}`);
  return height;
}

function blockTime(payload = {}) {
  const value = payload?.result?.block?.header?.time
    || payload?.block?.header?.time
    || payload?.blockTime;
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) throw new Error('THORChain block response did not include a valid time');
  return new Date(parsed).toISOString();
}

function normalizedSnapshot(row = {}) {
  if (!row.height) return null;
  return {
    height: Number(row.height),
    blockTime: new Date(row.block_time).toISOString(),
    pools: Array.isArray(row.pools_json) ? row.pools_json : [],
    oraclePrices: Array.isArray(row.oracle_prices_json) ? row.oracle_prices_json : [],
    source: String(row.source || 'thornode-historical')
  };
}

export async function loadThorchainMarketSnapshot(client, height) {
  const targetHeight = positiveHeight(height);
  const { rows } = await client.query(
    `select height, block_time, pools_json, oracle_prices_json, source
     from thorchain_market_snapshots
     where height = $1
     limit 1`,
    [targetHeight]
  );
  return normalizedSnapshot(rows[0]);
}

export async function persistThorchainMarketSnapshot(client, snapshot = {}) {
  const height = positiveHeight(snapshot.height);
  const pools = Array.isArray(snapshot.pools) ? snapshot.pools : [];
  const oraclePrices = Array.isArray(snapshot.oraclePrices?.prices)
    ? snapshot.oraclePrices.prices
    : Array.isArray(snapshot.oraclePrices) ? snapshot.oraclePrices : [];
  if (!pools.length) throw new Error(`Cannot persist empty pool snapshot at height ${height}`);
  const time = blockTime({ blockTime: snapshot.blockTime });
  await client.query(
    `insert into thorchain_market_snapshots (
       height, block_time, pools_json, oracle_prices_json, source, observed_at, updated_at
     ) values ($1, $2, $3, $4, $5, now(), now())
     on conflict (height)
     do update set
       block_time = excluded.block_time,
       pools_json = excluded.pools_json,
       oracle_prices_json = excluded.oracle_prices_json,
       source = excluded.source,
       updated_at = now()`,
    [
      height,
      time,
      JSON.stringify(pools),
      JSON.stringify(oraclePrices),
      String(snapshot.source || 'thornode-historical')
    ]
  );
  return { height, blockTime: time, pools, oraclePrices, source: snapshot.source || 'thornode-historical' };
}

export async function ensureThorchainMarketSnapshot(client, height, options = {}) {
  const targetHeight = positiveHeight(height);
  const cached = await loadThorchainMarketSnapshot(client, targetHeight);
  if (cached) return { ...cached, cached: true };

  const fetchThor = options.fetchThorchain || fetchThorchain;
  const fetchRpc = options.fetchRpc || fetchThorchainRpc;
  // The three provider calls run concurrently. Cooldown bookkeeping therefore
  // uses the shared pool by default instead of issuing overlapping queries on
  // the advisory-lock client.
  const cooldownClient = options.cooldownClient;
  const [poolsPayload, oraclePayload, blockPayload] = await Promise.all([
    fetchThor(`/thorchain/pools?height=${targetHeight}`, {
      historical: true,
      timeoutMs: options.timeoutMs || 30_000,
      cooldownClient,
      sharedCooldown: true
    }),
    fetchThor(`/thorchain/oracle/prices?height=${targetHeight}`, {
      historical: true,
      timeoutMs: options.timeoutMs || 30_000,
      cooldownClient,
      sharedCooldown: true
    }),
    (options.fetchBlock || fetchRpc)(
      '/block',
      { height: targetHeight },
      { cooldownClient, sharedCooldown: true }
    )
  ]);
  const pools = Array.isArray(poolsPayload) ? poolsPayload : poolsPayload?.pools || [];
  const oraclePrices = oraclePayload?.prices || oraclePayload || [];
  const snapshot = await persistThorchainMarketSnapshot(client, {
    height: targetHeight,
    blockTime: blockTime(blockPayload),
    pools,
    oraclePrices,
    source: options.source || 'thornode-historical'
  });
  return { ...snapshot, cached: false };
}

export async function pruneThorchainMarketSnapshots(client, retentionDays = 400) {
  return client.query(
    `delete from thorchain_market_snapshots
     where block_time < now() - ($1::text || ' days')::interval`,
    [Math.max(30, Math.trunc(Number(retentionDays) || 400))]
  );
}
