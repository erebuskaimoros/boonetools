import { error, json } from '../lib/http.js';
import {
  POOL_DISLOCATION_MODEL_KEY,
  buildPoolDislocationSeries
} from '../shared/pool-dislocation.js';
import { createReadModelEtag, getReadModel } from '../shared/read-models.js';

async function defaultQuery(...args) {
  const { query } = await import('../db/pool.js');
  return query(...args);
}

function headersForModel(model, etag = model?.etag) {
  const stale = Boolean(model?.stale);
  return {
    'Cache-Control': stale
      ? 'public, max-age=15, stale-if-error=900'
      : 'public, max-age=60, stale-while-revalidate=240, stale-if-error=900',
    ...(etag ? { ETag: etag } : {}),
    'X-Boone-Cache': stale ? 'read-model-stale' : 'read-model',
    'X-Boone-Age': String(model?.ageSeconds ?? 0),
    'X-Boone-Read-Model-Stale': stale ? '1' : '0'
  };
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
  return json({
    ...model.payload,
    stale,
    warnings: [...new Set([
      ...(model.payload?.warnings || []),
      ...(stale ? ['Serving the last successful pool-dislocation snapshot'] : [])
    ])],
    read_model: {
      key: model.key,
      generated_at: model.generatedAt,
      source_updated_at: model.sourceUpdatedAt,
      fresh_until: model.freshUntil,
      stale
    }
  }, 200, headersForModel(model));
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
