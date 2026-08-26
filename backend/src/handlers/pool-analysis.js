import { error, json } from '../lib/http.js';
import { createReadModelEtag } from '../shared/read-models.js';
import {
  buildPoolAnalysisSeries,
  getPoolAnalysisReadModel
} from '../shared/pool-analysis.js';
import { loadPoolAnalysisSeries } from '../shared/pool-analysis-store.js';

async function defaultLoadSeries(asset) {
  const { query } = await import('../db/pool.js');
  return loadPoolAnalysisSeries({ query }, asset);
}

function modelHeaders(model, etag, detail = false) {
  const stale = Boolean(model?.stale);
  return {
    'Cache-Control': stale
      ? 'public, max-age=15, stale-if-error=900'
      : detail
        ? 'public, max-age=300, stale-while-revalidate=900, stale-if-error=3600'
        : 'public, max-age=60, stale-while-revalidate=240, stale-if-error=900',
    ETag: etag,
    'X-Boone-Cache': stale ? 'read-model-stale' : 'read-model',
    'X-Boone-Age': String(model?.ageSeconds ?? 0),
    'X-Boone-Read-Model-Stale': stale ? '1' : '0'
  };
}

export async function handlePoolAnalysis(_request, _url, options = {}) {
  const model = await (options.getReadModel || getPoolAnalysisReadModel)();
  if (!model) {
    return error('Pool Analysis is warming', 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '300'
    });
  }
  const payload = {
    ...model.payload,
    stale: Boolean(model.stale),
    warnings: [...new Set([
      ...(Array.isArray(model.payload?.warnings) ? model.payload.warnings : []),
      ...(model.stale ? ['Serving the last successful Pool Analysis snapshot'] : [])
    ])],
    read_model: {
      key: model.key,
      schema_version: model.schemaVersion,
      generated_at: model.generatedAt,
      source_updated_at: model.sourceUpdatedAt,
      fresh_until: model.freshUntil,
      stale: Boolean(model.stale)
    }
  };
  const etag = createReadModelEtag(payload);
  return json(payload, 200, modelHeaders(model, etag));
}

export async function handlePoolAnalysisSeries(_request, url, options = {}) {
  const asset = String(url?.searchParams?.get('asset') || '').trim().toUpperCase();
  const range = String(url?.searchParams?.get('range') || '30d').trim().toLowerCase();
  if (!asset || asset.length > 160 || !/^[A-Z0-9._:-]+$/.test(asset)) {
    return error('A valid asset query parameter is required', 400, { 'Cache-Control': 'no-store' });
  }
  if (!['30d', 'all'].includes(range)) {
    return error('Range must be 30d or all', 400, { 'Cache-Control': 'no-store' });
  }
  const model = await (options.getReadModel || getPoolAnalysisReadModel)();
  if (!model) {
    return error('Pool Analysis is warming', 503, {
      'Cache-Control': 'no-store',
      'Retry-After': '300'
    });
  }
  const pool = (Array.isArray(model.payload?.pools) ? model.payload.pools : [])
    .find((candidate) => candidate.asset === asset);
  if (!pool) return error('Pool is not present in the current pool set', 404);
  const rows = await (options.loadSeries || defaultLoadSeries)(asset);
  if (!rows.length) return error('Pool history is still warming', 503, { 'Retry-After': '300' });
  const series = buildPoolAnalysisSeries(rows, {
    range,
    asOf: model.payload?.as_of || model.generatedAt
  });
  const payload = {
    schema_version: 1,
    as_of: model.payload?.as_of || model.generatedAt,
    asset,
    symbol: pool.symbol,
    range,
    ...series,
    stale: Boolean(model.stale),
    sources: { history: 'liquify-midgard:history/swaps' },
    warnings: [
      ...(series.coverage.missing_days.length
        ? [`${series.coverage.missing_days.length} UTC day(s) are missing in this window`]
        : []),
      ...(model.stale ? ['Series is aligned to the last successful Pool Analysis snapshot'] : [])
    ]
  };
  const etag = createReadModelEtag(payload);
  return json(payload, 200, modelHeaders(model, etag, true));
}
