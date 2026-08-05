import { json, parseIntegerParam } from '../lib/http.js';
import { query } from '../db/pool.js';
import { loadBlockIntervalSeries } from '../shared/chain-headers.js';

export async function handleBlockProduction(_request, url, options = {}) {
  const client = options.client || { query };
  const hours = parseIntegerParam(url?.searchParams?.get('hours'), 24, { min: 1, max: 24 });
  const afterHeight = parseIntegerParam(url?.searchParams?.get('after_height'), 0, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER
  });
  const limit = parseIntegerParam(url?.searchParams?.get('limit'), 20_000, {
    min: 1,
    max: 20_000
  });
  const payload = await (options.loadSeries || loadBlockIntervalSeries)(client, {
    hours,
    afterHeight,
    limit,
    nowMs: options.nowMs
  });
  return json(payload, 200, {
    'Cache-Control': 'no-store',
    'X-Boone-Cache': 'postgres-chain-headers'
  });
}
