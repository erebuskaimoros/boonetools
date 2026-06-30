import { query } from '../db/pool.js';
import { error, json, parseIntegerParam } from '../lib/http.js';
import { summarizeDuneError } from '../shared/dune.js';
import { getCachedResponse, setCachedResponse } from '../shared/response-cache.js';
import { fetchRapidSwapMarketHistoryFromDune } from '../shared/rapid-swaps.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const ALLOWED_INTERVALS = new Set(['hour', 'day', 'week', 'month']);

function buildParams(url) {
  const interval = String(url.searchParams.get('interval') || 'hour').toLowerCase();
  if (!ALLOWED_INTERVALS.has(interval)) {
    throw new Error('Invalid interval parameter');
  }

  const params = {
    interval
  };

  const pool = String(url.searchParams.get('pool') || '').trim();
  if (pool) {
    params.pool = pool;
  }

  const from = parseIntegerParam(url.searchParams.get('from'), 0, { min: 0 });
  const to = parseIntegerParam(url.searchParams.get('to'), 0, { min: 0 });
  const count = parseIntegerParam(url.searchParams.get('count'), 0, { min: 0, max: 400 });

  if (from > 0 || to > 0) {
    if (from <= 0 || to <= 0 || from > to) {
      throw new Error('Invalid from/to parameters');
    }
    params.from = String(from);
    params.to = String(to);
  } else if (count > 0) {
    params.count = String(count);
  }

  return params;
}

function cacheKeyForParams(params) {
  const normalized = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    normalized.set(key, String(params[key]));
  }
  return `dune:history:swaps:${normalized.toString()}`;
}

function intervalSeconds(interval) {
  if (interval === 'month') return 30 * 24 * 60 * 60;
  if (interval === 'week') return 7 * 24 * 60 * 60;
  if (interval === 'day') return 24 * 60 * 60;
  return 60 * 60;
}

function getDuneHistoryRange(params) {
  const to = Number(params.to || 0) > 0
    ? Number(params.to)
    : Math.floor(Date.now() / 1000);
  const from = Number(params.from || 0) > 0
    ? Number(params.from)
    : to - Math.max(1, Number(params.count || 24) || 24) * intervalSeconds(params.interval);
  return {
    from: Math.max(0, Math.trunc(from)),
    to: Math.max(Math.trunc(from), Math.trunc(to))
  };
}

async function fetchRapidSwapMarketHistoryFromLocalDb(params, range) {
  const seconds = intervalSeconds(params.interval);
  const { rows } = await query(
    `with bucketed as (
       select date_trunc($3, action_date at time zone 'UTC') at time zone 'UTC' as bucket_start,
              count(*)::bigint as total_count,
              coalesce(sum(comparable_volume_usd), 0) as total_volume_usd
       from rapid_swaps
       where action_date >= to_timestamp($1)
         and action_date < to_timestamp($2)
       group by 1
     )
     select extract(epoch from bucket_start)::bigint as start_time,
            extract(epoch from bucket_start + ($4::int * interval '1 second'))::bigint as end_time,
            total_count,
            total_volume_usd
     from bucketed
     order by bucket_start asc`,
    [range.from, range.to, params.interval, seconds]
  );

  return {
    meta: {
      source: 'boonetools-postgres',
      fallback_for: 'dune'
    },
    intervals: (rows || []).map((row) => ({
      startTime: String(Math.max(0, Math.trunc(Number(row.start_time || 0)))),
      endTime: String(Math.max(0, Math.trunc(Number(row.end_time || 0)))),
      totalVolumeUSD: String(Math.max(0, Math.trunc(Number(row.total_volume_usd || 0)))),
      totalCount: String(Math.max(0, Math.trunc(Number(row.total_count || 0))))
    }))
  };
}

export async function handleRapidSwapsSwapHistory(_request, url) {
  let params;
  try {
    params = buildParams(url);
  } catch (buildError) {
    return error(buildError.message || 'Invalid swap history parameters', 400);
  }

  const cacheKey = cacheKeyForParams(params);
  const cached = await getCachedResponse(cacheKey);
  if (cached) {
    return json(cached.payload, 200, {
      'Cache-Control': 'public, max-age=60'
    });
  }

  try {
    const range = getDuneHistoryRange(params);
    const payload = await fetchRapidSwapMarketHistoryFromDune({
      interval: params.interval,
      from: range.from,
      to: range.to
    });
    await setCachedResponse(cacheKey, payload, CACHE_TTL_MS);
    return json(payload, 200, {
      'Cache-Control': 'public, max-age=60'
    });
  } catch (historyError) {
    const range = getDuneHistoryRange(params);
    let localPayload = null;
    let localError = null;
    try {
      localPayload = await fetchRapidSwapMarketHistoryFromLocalDb(params, range);
      if (localPayload.intervals.length > 0) {
        const payload = {
          ...localPayload,
          stale: false,
          warning: 'Served local swap history after Dune fetch failure',
          dune_error: summarizeDuneError(historyError)
        };
        await setCachedResponse(cacheKey, payload, CACHE_TTL_MS);
        return json(payload, 200, {
          'Cache-Control': 'public, max-age=60'
        });
      }
    } catch (error) {
      localError = error;
    }

    const stale = await getCachedResponse(cacheKey, { allowStale: true });
    if (stale) {
      return json(
        {
          ...stale.payload,
          stale: true,
          warning: 'Served cached swap history after Dune fetch failure',
          dune_error: summarizeDuneError(historyError),
          ...(localError ? { local_fallback_error: localError.message || String(localError) } : {})
        },
        200,
        {
          'Cache-Control': 'public, max-age=30'
        }
      );
    }

    if (localPayload) {
      const payload = {
        ...localPayload,
        stale: false,
        warning: 'Served local swap history after Dune fetch failure',
        dune_error: summarizeDuneError(historyError)
      };
      await setCachedResponse(cacheKey, payload, CACHE_TTL_MS);
      return json(payload, 200, {
        'Cache-Control': 'public, max-age=60'
      });
    }

    throw historyError;
  }
}
