import { acquireCached, loadAcquisition, saveAcquisition } from './acquisition-cache.js';
import { getThorNodeCoreSnapshot, isThorNodeCoreSnapshotStale, THORNODE_CORE_FIELDS } from './thornode-core-snapshot.js';
import { fetchThorchain } from './thornode.js';
import { fetchMidgard } from './midgard.js';
import { loadRujiraRunePrices } from './rujira-rune-prices.js';

const NAMESPACE = 'visitor-snapshot:v1';
const VALID_AFFILIATE = /^[a-z0-9._-]{1,128}$/i;
export const VISITOR_SNAPSHOT_KINDS = ['dynamic-fees', 'vault', 'affiliate-history'];
const ttl = (kind) => kind === 'affiliate-history' ? 15 * 60_000 : 60_000;

export function visitorSnapshotKey(kind, params = {}) {
  if (!VISITOR_SNAPSHOT_KINDS.includes(kind)) throw new Error('Invalid visitor snapshot kind');
  if (kind !== 'affiliate-history') return kind;
  const affiliate = String(params.affiliate || '').toLowerCase();
  if (!VALID_AFFILIATE.test(affiliate)) throw new Error('Invalid affiliate parameter');
  return `${kind}:${affiliate}:${new Date().toISOString().slice(0, 10)}`;
}

export async function readVisitorSnapshot(client, kind, params = {}) {
  const key = visitorSnapshotKey(kind, params);
  const record = await loadAcquisition(client, NAMESPACE, key, { allowStale: true });
  if (!record || record.stale) await client.query(`insert into visitor_snapshot_requests (snapshot_key, kind, params_json)
    values ($1, $2, $3::jsonb) on conflict (snapshot_key) do update set
      pending = true, requested_at = now()`, [key, kind, JSON.stringify(params)]);
  return record ? { ...record.payload, stale: record.stale || Number(record.payload?.pending_prices) > 0 || Number(record.payload?.pending_details) > 0, observed_at: record.observedAt } : null;
}

export async function buildVisitorSnapshot(kind, params = {}, options = {}) {
  const client = options.client;
  const acquire = options.acquire || acquireCached;
  const fetchThor = options.fetchThorchain || fetchThorchain;
  const fetchHistory = options.fetchMidgard || fetchMidgard;
  const fieldMeta = {};
  let requests = 0;
  const maxRequests = Math.max(3, Math.min(32, Number(options.maxRequests) || 12));
  async function current(field, path, validate = (value) => value && typeof value === 'object', ttlMs = 60_000, identity = path) {
    const value = await acquire(client, { namespace: 'thornode:visitor-current:v1', identity, ttlMs,
      source: 'thornode', validate, load: (db) => {
        if (requests >= maxRequests) throw Object.assign(new Error('Visitor acquisition request budget reached'), { code: 'visitor_request_budget' });
        requests += 1;
        return fetchThor(path, { cooldownClient: db });
      } });
    fieldMeta[field] = { fetched_at: value.observedAt,
      expires_at: value.expiresAt || new Date(Date.parse(value.observedAt) + ttlMs).toISOString(),
      status: value.stale ? 'reused' : 'fresh' };
    return value.payload;
  }
  if (kind === 'affiliate-history') {
    const affiliate = String(params.affiliate || '').toLowerCase();
    if (!VALID_AFFILIATE.test(affiliate)) throw new Error('Invalid affiliate parameter');
    const day = new Date().toISOString().slice(0, 10);
    const earnings = await acquire(client, { namespace: 'midgard:affiliate-earnings:v1', identity: `${affiliate}:${day}`, ttlMs: ttl(kind),
      source: 'midgard', validate: Array.isArray, load: async (db) => {
        const result = await fetchHistory(`/history/affiliate/earnings?thorname=${encodeURIComponent(affiliate)}&interval=day&count=400`, { cooldownClient: db });
        return Array.isArray(result) ? result : result?.intervals;
      } });
    // Midgard's historical earningsUSD uses its current RUNE price. This
    // response remains refreshable; permanently sealing those USD amounts
    // would silently change the dashboard's display valuation convention.
    const todayMs = Date.parse(`${day}T00:00:00Z`);
    const starts = Array.from({ length: 400 }, (_, index) => new Date(todayMs - index * 86400000).toISOString().slice(0, 10));
    const prices = await (options.loadRunePrices || loadRujiraRunePrices)(client, starts, { interval: 'day', fetchMidgard: fetchHistory });
    const mutablePriceExpiries = prices.rows.filter((row) => !row.completed).map((row) => Date.parse(row.observedAt || '') + 5 * 60_000).filter(Number.isFinite);
    return { earningsRows: earnings.payload, runePriceRows: prices.rows.map((row) => row.source_json), pending_prices: prices.pending_buckets, field_meta: {
      earnings: { fetched_at: earnings.observedAt, expires_at: earnings.expiresAt },
      rune_prices: { fetched_at: prices.rows.map((row) => row.observedAt).filter(Boolean).sort().at(-1) || null,
        expires_at: mutablePriceExpiries.length ? new Date(Math.min(...mutablePriceExpiries)).toISOString() : null }
    } };
  }
  const core = options.coreSnapshot || await getThorNodeCoreSnapshot({ client, allowStale: true, cache: false });
  const required = kind === 'vault' ? ['pools', 'network', 'nodes', 'inbound_addresses'] : ['mimir', 'lastblock'];
  if (isThorNodeCoreSnapshotStale(core, required)) throw new Error('Shared THORNode core snapshot is stale');
  const payload = core?.payload || core;
  for (const field of required) {
    const meta = payload.field_meta?.[field] || {};
    const cadence = THORNODE_CORE_FIELDS.find((entry) => entry.key === field)?.cadenceMs || 60_000;
    const observedMs = Date.parse(meta.fetched_at || '');
    fieldMeta[field] = { ...meta, expires_at: Number.isFinite(observedMs) ? new Date(observedMs + cadence).toISOString() : core.freshUntil || null };
  }
  if (kind === 'vault') {
    const vaults = await current('vaults', '/thorchain/vaults/asgard', Array.isArray);
    const tradeUnits = await current('trade_units', '/thorchain/trade/units', Array.isArray);
    const securedAssets = await current('secured_assets', '/thorchain/securedassets', Array.isArray);
    return { vaults, tradeUnits, securedAssets, pools: payload.pools, network: payload.network,
      nodes: payload.nodes, inboundAddresses: payload.inbound_addresses, field_meta: fieldMeta };
  }
  if (kind !== 'dynamic-fees') throw new Error('Invalid visitor snapshot kind');
  const recordsResponse = await current('records', '/thorchain/dynamic_l1_fees', (value) => Array.isArray(value?.entries));
  const currentResponse = await current('current', '/thorchain/dynamic_l1_fees_current', (value) => value && typeof value === 'object', 30_000);
  const thornames = [...new Set(recordsResponse.entries.map((row) => String(row.thorname || '').toLowerCase()).filter(Boolean))];
  const detailsByThorname = {};
  let pendingDetails = 0;
  for (const thorname of thornames) {
    if (!VALID_AFFILIATE.test(thorname)) continue;
    const detailPath = `/thorchain/dynamic_l1_fees/${encodeURIComponent(thorname)}`;
    const epoch = currentResponse.epoch ?? currentResponse.current_epoch ?? currentResponse.currentEpoch ?? '';
    try {
      detailsByThorname[thorname] = await current(`detail:${thorname}`, detailPath, undefined, 15 * 60_000, `${detailPath}:epoch:${epoch}`);
    } catch (error) {
      if (error.code !== 'visitor_request_budget') throw error;
      pendingDetails += 1;
      const previous = options.previousSnapshot?.detailsByThorname?.[thorname];
      if (previous) {
        detailsByThorname[thorname] = previous;
        fieldMeta[`detail:${thorname}`] = { ...options.previousSnapshot.field_meta?.[`detail:${thorname}`], status: 'reused' };
      }
    }
  }
  return { mimir: payload.mimir, lastblock: payload.lastblock, recordsResponse, currentResponse, detailsByThorname, pending_details: pendingDetails, field_meta: fieldMeta };
}

export async function refreshVisitorSnapshots(client, options = {}) {
  // Warm each global surface once after installation. Subsequent refreshes
  // require visitor demand, so unused pages create no recurring provider work.
  await client.query(`insert into visitor_snapshot_requests (snapshot_key, kind)
    values ('vault', 'vault'), ('dynamic-fees', 'dynamic-fees') on conflict do nothing`);
  const { rows } = await client.query(`select * from visitor_snapshot_requests
    where pending and available_at <= now() order by requested_at limit 4`);
  const stats = { refreshed: 0, errors: [] };
  for (const request of rows) {
    try {
      const previous = await loadAcquisition(client, NAMESPACE, request.snapshot_key, { allowStale: true });
      const payload = await (options.build || buildVisitorSnapshot)(request.kind, request.params_json, { ...options, client, previousSnapshot: previous?.payload });
      const now = new Date();
      const sourceTimes = Object.values(payload.field_meta || {}).map((meta) => Date.parse(meta?.fetched_at || '')).filter(Number.isFinite);
      const observedAt = sourceTimes.length ? new Date(Math.min(...sourceTimes)).toISOString() : now.toISOString();
      const sourceExpiries = Object.values(payload.field_meta || {}).map((meta) => Date.parse(meta?.expires_at || '')).filter(Number.isFinite);
      const expiresAt = new Date(Math.min(now.getTime() + ttl(request.kind), ...sourceExpiries)).toISOString();
      await saveAcquisition(client, { namespace: NAMESPACE, identity: request.snapshot_key,
        payload, source: 'shared-provider-observations', observedAt,
        expiresAt });
      await client.query(`update visitor_snapshot_requests set pending = $2, available_at = now() + interval '1 minute', last_error = null where snapshot_key = $1`, [request.snapshot_key, Number(payload.pending_prices) > 0 || Number(payload.pending_details) > 0]);
      stats.refreshed += 1;
    } catch (error) {
      stats.errors.push({ kind: request.kind, error: error?.message || String(error) });
      await client.query(`update visitor_snapshot_requests set available_at = now() + interval '1 minute', last_error = $2 where snapshot_key = $1`,
      [request.snapshot_key, error?.message || String(error)]);
    }
  }
  await client.query(`delete from visitor_snapshot_requests where not pending and kind = 'affiliate-history' and requested_at < now() - interval '7 days'`);
  return stats;
}
