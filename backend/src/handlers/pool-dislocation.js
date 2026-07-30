import { config } from '../lib/config.js';
import { error, json } from '../lib/http.js';
import {
  POOL_DISLOCATION_MODEL_KEY,
  applyPoolDislocationTradingStatus,
  normalizeChainTradingStatus,
  buildPoolDislocationSeries
} from '../shared/pool-dislocation.js';
import { createReadModelEtag, getReadModel } from '../shared/read-models.js';
import {
  coreSnapshotValue,
  getThorNodeCoreSnapshot,
  isThorNodeCoreSnapshotStale
} from '../shared/thornode-core-snapshot.js';

async function defaultQuery(...args) {
  const { query } = await import('../db/pool.js');
  return query(...args);
}

function headersForModel(model, etag = model?.etag, options = {}) {
  const stale = Boolean(model?.stale);
  const degraded = Boolean(options.degraded);
  return {
    'Cache-Control': stale || degraded
      ? 'public, max-age=15, stale-if-error=900'
      : 'public, max-age=60, stale-while-revalidate=240, stale-if-error=900',
    ...(etag ? { ETag: etag } : {}),
    'X-Boone-Cache': stale ? 'read-model-stale' : 'read-model',
    'X-Boone-Age': String(model?.ageSeconds ?? 0),
    'X-Boone-Read-Model-Stale': stale ? '1' : '0'
  };
}

function withoutSampledTradingWarnings(warnings = []) {
  return (Array.isArray(warnings) ? warnings : [])
    .filter((warning) => !/^trading\s*:/i.test(String(warning || '').trim()));
}

function coreFieldObservedAt(coreModel, field) {
  return coreModel?.payload?.field_meta?.[field]?.fetched_at
    || coreModel?.payload?.source_updated_at
    || coreModel?.sourceUpdatedAt
    || coreModel?.generatedAt
    || null;
}

function currentTimeMs(options = {}) {
  const value = typeof options.now === 'function' ? options.now() : new Date();
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function recentCoreFieldAgeMs(coreModel, field, options = {}) {
  const observedAt = coreFieldObservedAt(coreModel, field);
  const observedMs = Date.parse(String(observedAt || ''));
  const ageMs = currentTimeMs(options) - observedMs;
  const maxAgeMs = Math.max(0, Number(
    options.tradingFallbackMaxAgeMs ?? config.poolDislocationTradingFallbackMaxAgeMs
  ) || 0);
  if (!Number.isFinite(observedMs) || ageMs < -30_000 || ageMs > maxAgeMs) return null;
  return { observedAt, ageMs: Math.max(0, ageMs) };
}

function currentMimirNumber(coreModel, key) {
  const mimir = coreSnapshotValue(coreModel, 'mimir', {});
  const entry = Object.entries(mimir || {})
    .find(([candidate]) => String(candidate || '').toUpperCase() === key);
  const value = Number(entry?.[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function loadCurrentCoreOverlay(options = {}) {
  try {
    const coreModel = await (options.getThorNodeCoreSnapshot || getThorNodeCoreSnapshot)({
      allowStale: true
    });
    const inboundAddresses = coreSnapshotValue(coreModel, 'inbound_addresses');
    if (!Array.isArray(inboundAddresses)) {
      throw new Error('Current THORNode inbound-address state is invalid');
    }
    const tradingStale = isThorNodeCoreSnapshotStale(coreModel, ['inbound_addresses']);
    const tradingFallback = tradingStale
      ? recentCoreFieldAgeMs(coreModel, 'inbound_addresses', options)
      : null;
    if (tradingStale && !tradingFallback) {
      throw new Error('Current THORNode inbound-address state is unavailable or stale');
    }
    const tradingObservedAt = tradingFallback?.observedAt
      || coreFieldObservedAt(coreModel, 'inbound_addresses');
    const tradingError = tradingFallback
      ? `Current THORNode inbound-address refresh failed; retaining last known trading state from ${tradingObservedAt}`
      : null;
    const mimirStale = isThorNodeCoreSnapshotStale(coreModel, ['mimir']);
    const l1SlipMinBps = mimirStale ? null : currentMimirNumber(coreModel, 'L1SLIPMINBPS');
    const mimirError = l1SlipMinBps === null
      ? 'Current THORNode L1SlipMinBps state is unavailable or stale'
      : null;
    return {
      chainTrading: normalizeChainTradingStatus(inboundAddresses),
      l1SlipMinBps,
      source: {
        error: tradingError,
        status: tradingFallback ? 'cached' : 'fresh',
        provider: 'thornode-core-snapshot',
        observed_at: tradingObservedAt,
        ...(tradingFallback ? { age_ms: tradingFallback.ageMs } : {})
      },
      mimirSource: {
        error: mimirError,
        status: mimirError ? 'error' : 'fresh',
        provider: 'thornode-core-snapshot',
        observed_at: mimirError ? null : coreFieldObservedAt(coreModel, 'mimir')
      },
      degraded: Boolean(tradingFallback || mimirError)
    };
  } catch (error) {
    const message = error?.message || 'Current THORNode inbound-address state is unavailable';
    return {
      chainTrading: normalizeChainTradingStatus(),
      l1SlipMinBps: null,
      source: {
        error: message,
        status: 'error',
        provider: 'thornode-core-snapshot',
        observed_at: null
      },
      mimirSource: {
        error: 'Current THORNode L1SlipMinBps state is unavailable or stale',
        status: 'error',
        provider: 'thornode-core-snapshot',
        observed_at: null
      },
      degraded: true
    };
  }
}

export async function handlePoolDislocation(_request, _url, options = {}) {
  const model = await (options.getReadModel || getReadModel)(POOL_DISLOCATION_MODEL_KEY);
  if (!model) {
    return error('Pool dislocation history is warming', 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '300'
    });
  }
  const stale = Boolean(model.stale);
  const current = await loadCurrentCoreOverlay(options);
  const payload = applyPoolDislocationTradingStatus(model.payload, current.chainTrading);
  const warnings = withoutSampledTradingWarnings(model.payload?.warnings);
  if (current.source.error) warnings.push(`trading: ${current.source.error}`);
  if (current.mimirSource.error) warnings.push(`mimir: ${current.mimirSource.error}`);
  const body = {
    ...payload,
    l1_slip_min_bps: current.l1SlipMinBps,
    sources: {
      ...(payload.sources || {}),
      trading: current.source,
      mimir: current.mimirSource
    },
    stale,
    warnings: [...new Set([
      ...warnings,
      ...(stale ? ['Serving the last successful pool-dislocation snapshot'] : [])
    ])],
    read_model: {
      key: model.key,
      generated_at: model.generatedAt,
      source_updated_at: model.sourceUpdatedAt,
      fresh_until: model.freshUntil,
      stale
    }
  };
  const etag = createReadModelEtag({
    summary: model.etag,
    chain_trading: body.chain_trading,
    trading_source: body.sources.trading,
    l1_slip_min_bps: body.l1_slip_min_bps,
    mimir_source: body.sources.mimir,
    stale
  });
  return json(body, 200, headersForModel(model, etag, { degraded: current.degraded }));
}

export async function handlePoolDislocationSeries(_request, url, options = {}) {
  const asset = String(url?.searchParams?.get('asset') || '').trim().toUpperCase();
  if (!asset || asset.length > 160 || !/^[A-Z0-9._:-]+$/.test(asset)) {
    return error('A valid asset query parameter is required', 400, { 'Cache-Control': 'no-store' });
  }
  const model = await (options.getReadModel || getReadModel)(POOL_DISLOCATION_MODEL_KEY);
  if (!model) {
    return error('Pool dislocation history is warming', 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '300'
    });
  }
  const pool = model.payload?.pools?.find((candidate) => candidate.asset === asset);
  if (!pool) return error('Pool is not present in the current Available pool set', 404);

  const asOf = model.payload?.as_of || model.generatedAt;
  const execute = options.query || defaultQuery;
  const { rows } = await execute(
    `select observed_at, asset, symbol, chain, pool_status,
            pool_price_usd, oracle_symbol, oracle_price_usd,
            binance_symbol, binance_price_usd,
            sample_origin, thorchain_height, pool_price_method,
            oracle_price_method, binance_price_method
     from pool_dislocation_observations
     where asset = $1
       and observed_at between $2::timestamptz - interval '7 days' and $2::timestamptz
     order by observed_at
     limit 2017`,
    [asset, asOf]
  );
  const payload = {
    ...buildPoolDislocationSeries(rows, { asset, asOf }),
    stale: Boolean(model.stale),
    warnings: model.stale ? ['Serving series aligned to the last successful summary snapshot'] : []
  };
  const etag = createReadModelEtag(payload);
  return json(payload, 200, headersForModel(model, etag));
}
