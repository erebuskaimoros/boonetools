import { upsertRows } from '../db/sql.js';
import { config } from '../lib/config.js';
import { safeNumber, sleep } from '../lib/utils.js';
import { executeDuneQueryRows, isDuneLimitError, summarizeDuneError } from './dune.js';
import { fetchMidgard } from './midgard.js';
import { computeFeesPerBillionUsd } from './tc-fee-dash.js';

const BILLION = 1_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RUNE_BASE = 100_000_000;
const SYNC_KEY = 'daily';
const DEFILLAMA_DEX_VOLUME_URL = 'https://api.llama.fi/overview/dexs?excludeTotalDataChartBreakdown=true&dataType=dailyVolume';
const CMC_VOLUME_FIELDS = [
  'totalVolume24H',
  'totalVolume24h',
  'total_volume_24h',
  'totalVolume24HReported',
  'total_volume_24h_reported',
  'volume_24h'
];

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date.toISOString().slice(0, 10);
}

function parseDateKey(value) {
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return parsed;
}

function addDays(value, days) {
  const date = parseDateKey(value);
  return dateKey(new Date(date.getTime() + days * DAY_MS));
}

function unixStart(date) {
  return Math.floor(parseDateKey(date).getTime() / 1000);
}

function isoStart(date) {
  return `${dateKey(parseDateKey(date))}T00:00:00.000Z`;
}

function dateRange(startDate, dayCount) {
  return Array.from({ length: dayCount }, (_, index) => addDays(startDate, index));
}

function shortDateLabel(date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(parseDateKey(date));
}

function isRateLimitError(error) {
  const status = Number(error?.status || 0);
  return status === 429 || /HTTP 429|Too Many Requests|rate.?limit/i.test(String(error?.message || ''));
}

function isDuneBackfillError(error) {
  const text = `${error?.message || ''} ${error?.body || ''}`;
  return /Dune/i.test(text);
}

function firstValue(row, names) {
  for (const name of names) {
    if (row?.[name] !== undefined && row?.[name] !== null) {
      return row[name];
    }
  }
  return undefined;
}

function isCmcProApiUrl() {
  return /pro-api\.coinmarketcap\.com/i.test(config.cmcGlobalMetricsHistoricalUrl);
}

async function withHttpError(response, url) {
  if (response.ok) return response;

  const body = await response.text().catch(() => '');
  const error = new Error(`HTTP ${response.status} from ${url}${body ? `: ${body.slice(0, 500)}` : ''}`);
  error.status = response.status;
  error.url = url;
  throw error;
}

async function fetchJson(url, options = {}) {
  const response = await withHttpError(await fetch(url, options), url);
  return response.json();
}

export function parseCmcGlobalVolumeDays(payload) {
  const quotes = Array.isArray(payload?.data?.quotes) ? payload.data.quotes : [];
  const entries = [];

  for (const row of quotes) {
    const quote = Array.isArray(row?.quote)
      ? row.quote.find((entry) => String(entry?.name || '').toUpperCase() === 'USD') || row.quote[0] || {}
      : row?.quote?.USD || row?.quote?.usd || row?.quote || {};
    const timestamp = row?.timestamp || quote.timestamp || quote.last_updated || row?.last_updated;
    if (!timestamp) continue;

    const volume = safeNumber(CMC_VOLUME_FIELDS
      .map((field) => quote[field])
      .find((value) => value !== undefined && value !== null));
    if (volume <= 0) continue;

    try {
      entries.push([dateKey(timestamp), {
        cmcVolume24hUsd: volume,
        raw: row
      }]);
    } catch {
      // Ignore malformed provider rows rather than failing an otherwise usable batch.
    }
  }

  return new Map(entries);
}

async function fetchCmcGlobalVolumeDays(startDate, count) {
  const cmcUrl = config.cmcGlobalMetricsHistoricalUrl;
  const usesProApi = isCmcProApiUrl();
  if (usesProApi && !config.cmcApiKey) {
    const error = new Error('Missing CMC_API_KEY for TC Fee Dash daily backfill');
    error.code = 'missing_cmc_api_key';
    throw error;
  }

  const params = usesProApi
    ? new URLSearchParams({
        time_start: isoStart(startDate),
        time_end: isoStart(addDays(startDate, count)),
        interval: config.cmcGlobalMetricsInterval,
        convert: 'USD',
        aux: 'total_volume_24h,total_volume_24h_reported'
      })
    : new URLSearchParams({
        format: 'chart_crypto_details',
        interval: config.cmcGlobalMetricsInterval,
        timeStart: String(unixStart(startDate)),
        timeEnd: String(unixStart(addDays(startDate, count)))
      });
  const headers = usesProApi
    ? { Accept: 'application/json', 'X-CMC_PRO_API_KEY': config.cmcApiKey }
    : { Accept: 'application/json' };

  return parseCmcGlobalVolumeDays(await fetchJson(`${cmcUrl}?${params.toString()}`, { headers }));
}

export function parseDefiLlamaDexVolumeDays(payload) {
  const chart = Array.isArray(payload?.totalDataChart) ? payload.totalDataChart : [];
  const entries = [];

  for (const point of chart) {
    const timestamp = Array.isArray(point) ? point[0] : point?.date || point?.timestamp;
    const volume = Array.isArray(point) ? point[1] : point?.volume || point?.totalVolume;
    const numericVolume = safeNumber(volume);
    if (!timestamp || numericVolume < 0) continue;

    const timestampNumber = Number(timestamp);
    const timestampMs = Number.isFinite(timestampNumber)
      ? (timestampNumber > 1_000_000_000_000 ? timestampNumber : timestampNumber * 1000)
      : timestamp;

    try {
      entries.push([dateKey(timestampMs), {
        dexVolumeUsd: numericVolume,
        raw: point
      }]);
    } catch {
      // Ignore malformed provider rows rather than failing an otherwise usable batch.
    }
  }

  return new Map(entries);
}

async function fetchDefiLlamaDexVolumeDays(startDate, count) {
  const startMs = parseDateKey(startDate).getTime();
  const endMs = parseDateKey(addDays(startDate, count)).getTime();
  const parsed = parseDefiLlamaDexVolumeDays(await fetchJson(DEFILLAMA_DEX_VOLUME_URL, {
    headers: { Accept: 'application/json' }
  }));
  return new Map([...parsed].filter(([day]) => {
    const dayMs = parseDateKey(day).getTime();
    return dayMs >= startMs && dayMs < endMs;
  }));
}

function dexVolumeForDay(dexVolumesByDate, day) {
  const entry = dexVolumesByDate?.get?.(day);
  return {
    value: safeNumber(entry?.dexVolumeUsd),
    raw: entry?.raw || null
  };
}

export function buildTcFeeDailyRowsFromDune(duneRows = [], options = {}) {
  const queryId = String(options.queryId || config.tcFeeDashDuneQueryId || '');
  const queryUrl = queryId ? `https://dune.com/queries/${queryId}` : '';
  const cmcVolumesByDate = options.cmcVolumesByDate || new Map();

  return duneRows.map((row) => {
    const day = dateKey(parseDateKey(firstValue(row, ['day', 'window_start', 'date'])));
    const cmcVolume = cmcVolumesByDate.get(day);
    const tcFeesRune = safeNumber(firstValue(row, ['tc_fees_rune', 'tcFeesRune', 'liquidity_fees']));
    const tcFeesUsd = safeNumber(firstValue(row, ['tc_fees_usd', 'tcFeesUsd', 'liquidity_fees_usd']));
    const runePriceUsd = safeNumber(firstValue(row, ['rune_price_usd', 'runePriceUsd']))
      || (tcFeesRune > 0 ? tcFeesUsd / tcFeesRune : 0);
    const duneMarketVolume24hUsd = safeNumber(firstValue(row, [
      'market_volume_24h_usd',
      'cmc_volume_24h_usd',
      'cex_volume_usd'
    ]));
    const cmcApiVolume24hUsd = safeNumber(cmcVolume?.cmcVolume24hUsd);
    const hasCmcApiVolume = cmcApiVolume24hUsd > 0;
    const cmcVolume24hUsd = cmcApiVolume24hUsd || duneMarketVolume24hUsd;
    const dexVolumeUsd = safeNumber(firstValue(row, [
      'dex_volume_usd',
      'defillama_dex_volume_usd',
      'dune_dex_volume_usd'
    ]));
    const duneExchangeVolumeUsd = safeNumber(firstValue(row, [
      'exchange_volume_usd',
      'global_exchange_volume_usd'
    ]));
    const exchangeVolumeUsd = hasCmcApiVolume
      ? cmcVolume24hUsd + dexVolumeUsd
      : duneExchangeVolumeUsd || duneMarketVolume24hUsd + dexVolumeUsd;
    const denominatorBasis = hasCmcApiVolume
      ? 'CMC historical global volume plus Dune indexed DEX trade volume'
      : String(firstValue(row, ['denominator_basis']) || 'Dune indexed exchange volume');

    return {
      id: `day:${day}`,
      period: 'day',
      window_start: day,
      window_end: addDays(day, 1),
      window_label: shortDateLabel(day),
      fee_bps: 0,
      tc_fees_rune: tcFeesRune,
      rune_price_usd: runePriceUsd,
      tc_fees_usd: tcFeesUsd,
      cmc_volume_24h_usd: cmcVolume24hUsd,
      defillama_dex_volume_usd: dexVolumeUsd,
      global_exchange_volume_usd: exchangeVolumeUsd,
      daily_median_fees_per_billion_usd: null,
      daily_range_low_fees_per_billion_usd: null,
      daily_range_high_fees_per_billion_usd: null,
      source_label: hasCmcApiVolume
        ? 'Dune TC fees + CMC volume + Dune DEX volume'
        : String(firstValue(row, ['source_label']) || 'Dune TC Fee Dash source query'),
      source_thread: queryUrl,
      source_json: {
        dune: row,
        cmc: cmcVolume?.raw || null,
        duneQueryId: queryId,
        feesPerBillionUsd: computeFeesPerBillionUsd(tcFeesUsd, exchangeVolumeUsd),
        denominatorBasis
      },
      fetched_at: new Date().toISOString()
    };
  }).filter((row) => (
    row.tc_fees_rune >= 0 &&
    row.rune_price_usd > 0 &&
    row.tc_fees_usd >= 0 &&
    row.global_exchange_volume_usd > 0
  ));
}

export function buildTcFeeDailyRowsFromMidgard(earningsIntervals = [], runeIntervals = [], options = {}) {
  const cmcVolumesByDate = options.cmcVolumesByDate || new Map();
  const dexVolumesByDate = options.dexVolumesByDate || new Map();
  const runePriceByDate = new Map();

  for (const interval of runeIntervals) {
    try {
      runePriceByDate.set(dateKey(Number(interval.startTime) * 1000), interval);
    } catch {
      // Ignore malformed provider rows rather than failing an otherwise usable batch.
    }
  }

  return earningsIntervals.map((interval) => {
    const day = dateKey(Number(interval.startTime) * 1000);
    const cmcVolume = cmcVolumesByDate.get(day);
    const dexVolume = dexVolumeForDay(dexVolumesByDate, day);
    const runeInterval = runePriceByDate.get(day) || {};
    const tcFeesRune = safeNumber(interval.liquidityFees) / RUNE_BASE;
    const runePriceUsd = safeNumber(runeInterval.runePriceUSD);
    const tcFeesUsd = tcFeesRune * runePriceUsd;
    const cmcVolume24hUsd = safeNumber(cmcVolume?.cmcVolume24hUsd);
    const globalExchangeVolumeUsd = cmcVolume24hUsd + dexVolume.value;
    const hasDexVolume = dexVolume.value > 0;

    return {
      id: `day:${day}`,
      period: 'day',
      window_start: day,
      window_end: addDays(day, 1),
      window_label: shortDateLabel(day),
      fee_bps: 0,
      tc_fees_rune: tcFeesRune,
      rune_price_usd: runePriceUsd,
      tc_fees_usd: tcFeesUsd,
      cmc_volume_24h_usd: cmcVolume24hUsd,
      defillama_dex_volume_usd: dexVolume.value,
      global_exchange_volume_usd: globalExchangeVolumeUsd,
      daily_median_fees_per_billion_usd: null,
      daily_range_low_fees_per_billion_usd: null,
      daily_range_high_fees_per_billion_usd: null,
      source_label: hasDexVolume
        ? 'Midgard TC fees + CMC volume + DeFiLlama DEX volume'
        : 'Midgard TC fees + CMC volume',
      source_thread: 'https://midgard.thorchain.network/v2/history/earnings',
      source_json: {
        midgard: interval,
        midgardRune: runeInterval,
        cmc: cmcVolume?.raw || null,
        defillama: dexVolume.raw,
        feesPerBillionUsd: computeFeesPerBillionUsd(tcFeesUsd, globalExchangeVolumeUsd),
        denominatorBasis: hasDexVolume
          ? 'CMC historical global volume plus DeFiLlama DEX volume'
          : 'CMC historical global volume'
      },
      fetched_at: new Date().toISOString()
    };
  }).filter((row) => (
    row.tc_fees_rune >= 0 &&
    row.rune_price_usd > 0 &&
    row.tc_fees_usd >= 0 &&
    row.cmc_volume_24h_usd > 0 &&
    row.global_exchange_volume_usd > 0
  ));
}

function indexRowsByDate(rows = []) {
  return new Map(rows.map((row) => [dateKey(row.window_start), row]));
}

export function mergeTcFeeRowsForDays(days, primaryRows = [], fallbackRows = []) {
  const primaryByDate = indexRowsByDate(primaryRows);
  const fallbackByDate = indexRowsByDate(fallbackRows);
  const rows = [];
  const primaryMissingDays = [];
  const missingDays = [];

  for (const day of days) {
    const primary = primaryByDate.get(day);
    if (primary) {
      rows.push(primary);
      continue;
    }

    primaryMissingDays.push(day);
    const fallback = fallbackByDate.get(day);
    if (fallback) {
      rows.push(fallback);
    } else {
      missingDays.push(day);
    }
  }

  return {
    rows,
    primaryMissingDays,
    missingDays
  };
}

async function fetchDuneTcFeeRows(startDate, count) {
  const endDate = addDays(startDate, count - 1);
  const result = await executeDuneQueryRows(config.tcFeeDashDuneQueryId, {
    start_date: startDate,
    end_date: endDate
  }, {
    limit: Math.max(count + 10, 100)
  });
  if (config.tcFeeDashRequestDelayMs > 0) {
    await sleep(config.tcFeeDashRequestDelayMs);
  }
  const cmcVolumesByDate = await fetchCmcGlobalVolumeDays(startDate, count);

  return {
    executionId: result.executionId,
    duneRows: result.rows.length,
    cmcRows: cmcVolumesByDate.size,
    rows: buildTcFeeDailyRowsFromDune(result.rows, {
      queryId: config.tcFeeDashDuneQueryId,
      cmcVolumesByDate
    })
  };
}

async function fetchMidgardTcFeeRows(startDate, count) {
  const params = new URLSearchParams({
    interval: 'day',
    from: String(unixStart(startDate)),
    to: String(unixStart(addDays(startDate, count)))
  });

  const [earnings, runeHistory, cmcVolumesByDate, dexVolumeResult] = await Promise.all([
    fetchMidgard(`/history/earnings?${params.toString()}`, {
      validateResponse: (_path, data) => !Array.isArray(data?.intervals)
    }),
    fetchMidgard(`/history/rune?${params.toString()}`, {
      validateResponse: (_path, data) => !Array.isArray(data?.intervals)
    }),
    fetchCmcGlobalVolumeDays(startDate, count),
    fetchDefiLlamaDexVolumeDays(startDate, count)
      .then((rows) => ({ rows, error: null }))
      .catch((error) => ({ rows: new Map(), error }))
  ]);

  return {
    earningsRows: earnings.intervals.length,
    runeRows: runeHistory.intervals.length,
    cmcRows: cmcVolumesByDate.size,
    dexRows: dexVolumeResult.rows.size,
    dexError: dexVolumeResult.error?.message || '',
    rows: buildTcFeeDailyRowsFromMidgard(earnings.intervals, runeHistory.intervals, {
      cmcVolumesByDate,
      dexVolumesByDate: dexVolumeResult.rows
    })
  };
}

async function getSyncState(client) {
  const { rows } = await client.query(
    `select sync_key, start_date, next_date, end_date, complete, rate_limited_until, stats_json
     from tc_fee_dash_sync_state
     where sync_key = $1`,
    [SYNC_KEY]
  );

  if (rows[0]) return rows[0];

  const startDate = config.tcFeeDashStartDate;
  const { rows: inserted } = await client.query(
    `insert into tc_fee_dash_sync_state (sync_key, start_date, next_date, end_date, stats_json)
     values ($1, $2, $2, null, '{}'::jsonb)
     on conflict (sync_key) do update set updated_at = now()
     returning sync_key, start_date, next_date, end_date, complete, rate_limited_until, stats_json`,
    [SYNC_KEY, startDate]
  );
  return inserted[0];
}

async function findEarliestMissingDailyDate(client, startDate, endDate) {
  const { rows } = await client.query(
    `with expected as (
       select generate_series($1::date, $2::date, interval '1 day')::date as day
     )
     select expected.day
     from expected
     left join tc_fee_dash_windows existing
       on existing.period = 'day'
      and existing.window_start = expected.day
     where existing.id is null
     order by expected.day asc
     limit 1`,
    [startDate, endDate]
  );
  return rows[0]?.day ? dateKey(rows[0].day) : '';
}

async function putCooldown(client, error) {
  const until = new Date(Date.now() + config.tcFeeDashRateLimitCooldownMs).toISOString();
  await client.query(
    `update tc_fee_dash_sync_state
     set rate_limited_until = $2,
         updated_at = now(),
         stats_json = coalesce(stats_json, '{}'::jsonb) || $3::jsonb
     where sync_key = $1`,
    [
      SYNC_KEY,
      until,
      JSON.stringify({
        rate_limited_at: new Date().toISOString(),
        rate_limit_error: error.message || String(error),
        source: 'dune+cmc'
      })
    ]
  );
  return until;
}

async function markDuneBackfillSkipped(client, syncState, payload = {}) {
  const reason = isDuneLimitError(payload.error) ? 'dune_limit_error' : 'dune_error';
  const duneError = summarizeDuneError(payload.error);
  const stats = {
    source: 'dune+cmc',
    status: 'degraded',
    skipped: true,
    reason,
    fallback_source: 'existing_cache',
    dune_query_id: config.tcFeeDashDuneQueryId,
    dune_error: duneError,
    start_date: payload.startDate || dateKey(syncState.next_date),
    end_date: payload.endDate || '',
    requested_days: payload.dayCount || 0,
    next_date: dateKey(syncState.next_date),
    observed_at: new Date().toISOString()
  };

  await client.query(
    `update tc_fee_dash_sync_state
     set updated_at = now(),
         stats_json = coalesce(stats_json, '{}'::jsonb) || $2::jsonb
     where sync_key = $1`,
    [SYNC_KEY, JSON.stringify(stats)]
  );

  return {
    ...stats,
    error: duneError.message
  };
}

function isCoolingDown(syncState) {
  const untilMs = Date.parse(String(syncState?.rate_limited_until || ''));
  return Number.isFinite(untilMs) && untilMs > Date.now();
}

function getEffectiveEndDate() {
  if (config.tcFeeDashEndDate) return config.tcFeeDashEndDate;
  const today = dateKey(new Date());
  return addDays(today, -Math.max(1, config.tcFeeDashHeadLagDays));
}

async function updateSyncState(client, payload) {
  await client.query(
    `update tc_fee_dash_sync_state
     set next_date = $2,
         end_date = $3,
         complete = $4,
         rate_limited_until = null,
         updated_at = now(),
         stats_json = $5
     where sync_key = $1`,
    [
      SYNC_KEY,
      payload.nextDate,
      payload.endDate,
      payload.complete,
      payload.stats || {}
    ]
  );
}

async function persistDailyRows(client, payload) {
  const {
    rows,
    days,
    startDate,
    endDate,
    source,
    sourceStats = {}
  } = payload;

  await upsertRows(client, 'tc_fee_dash_windows', rows, {
    conflictColumns: ['id'],
    jsonColumns: ['source_json']
  });

  const nextCandidate = addDays(startDate, days.length);
  const missingDays = Array.isArray(sourceStats.missingDays) ? sourceStats.missingDays : [];
  const nextDate = missingDays[0] || nextCandidate;
  const complete = missingDays.length === 0 && nextDate > endDate;
  const stats = {
    source,
    start_date: startDate,
    end_date: days.at(-1),
    effective_end_date: endDate,
    requested_days: days.length,
    inserted_or_updated_rows: rows.length,
    missing_days: missingDays.length,
    missing_day_list: missingDays,
    next_date: nextDate,
    complete,
    ...sourceStats,
    weighted_fees_per_billion_usd: rows.length
      ? computeFeesPerBillionUsd(
          rows.reduce((sum, row) => sum + row.tc_fees_usd, 0),
          rows.reduce((sum, row) => sum + row.global_exchange_volume_usd, 0)
        )
      : 0
  };

  await updateSyncState(client, {
    nextDate,
    endDate,
    complete,
    stats
  });

  return stats;
}

export async function runTcFeeDashDailyBackfill(client) {
  const syncState = await getSyncState(client);
  if (!config.duneApiKey) {
    return {
      skipped: true,
      reason: 'missing_dune_api_key',
      next_date: dateKey(syncState.next_date)
    };
  }
  if (!config.tcFeeDashDuneQueryId) {
    return {
      skipped: true,
      reason: 'missing_dune_tc_fee_query_id',
      next_date: dateKey(syncState.next_date)
    };
  }
  if (isCmcProApiUrl() && !config.cmcApiKey) {
    return {
      skipped: true,
      reason: 'missing_cmc_api_key',
      next_date: dateKey(syncState.next_date)
    };
  }

  if (isCoolingDown(syncState)) {
    return {
      skipped: true,
      reason: 'rate_limited',
      rate_limited_until: syncState.rate_limited_until
    };
  }

  const endDate = getEffectiveEndDate();
  const cursorDate = dateKey(syncState.next_date);
  const missingStartDate = await findEarliestMissingDailyDate(
    client,
    dateKey(syncState.start_date),
    endDate
  );
  const startDate = missingStartDate && missingStartDate < cursorDate
    ? missingStartDate
    : cursorDate;
  if (startDate > endDate) {
    await updateSyncState(client, {
      nextDate: startDate,
      endDate,
      complete: true,
      stats: {
        complete_at: new Date().toISOString(),
        source: 'dune+cmc',
        dune_query_id: config.tcFeeDashDuneQueryId
      }
    });
    return {
      skipped: true,
      reason: 'complete',
      next_date: startDate,
      end_date: endDate
    };
  }

  const requestedDays = Math.max(1, Math.min(400, config.tcFeeDashDaysPerRun));
  const remainingDays = Math.floor((parseDateKey(endDate).getTime() - parseDateKey(startDate).getTime()) / DAY_MS) + 1;
  const dayCount = Math.min(requestedDays, remainingDays);
  const days = dateRange(startDate, dayCount);

  try {
    const result = await fetchDuneTcFeeRows(startDate, dayCount);
    let fallback = null;
    let merged = mergeTcFeeRowsForDays(days, result.rows, []);

    if (merged.missingDays.length > 0) {
      fallback = await fetchMidgardTcFeeRows(startDate, dayCount);
      merged = mergeTcFeeRowsForDays(days, result.rows, fallback.rows);
    }

    return persistDailyRows(client, {
      rows: merged.rows,
      days,
      startDate,
      endDate,
      source: fallback ? 'dune+cmc+midgard_fallback' : 'dune+cmc',
      sourceStats: {
        missingDays: merged.missingDays,
        dune_query_id: config.tcFeeDashDuneQueryId,
        dune_execution_id: result.executionId,
        dune_rows: result.duneRows,
        cmc_rows: result.cmcRows,
        dune_missing_days: merged.primaryMissingDays.length,
        dune_missing_day_list: merged.primaryMissingDays,
        ...(fallback ? {
          fallback_source: 'midgard+cmc+defillama',
          fallback_earnings_rows: fallback.earningsRows,
          fallback_rune_rows: fallback.runeRows,
          fallback_cmc_rows: fallback.cmcRows,
          fallback_dex_rows: fallback.dexRows,
          ...(fallback.dexError ? { fallback_dex_error: fallback.dexError } : {})
        } : {})
      }
    });
  } catch (error) {
    if (isDuneBackfillError(error)) {
      try {
        const fallback = await fetchMidgardTcFeeRows(startDate, dayCount);
        const merged = mergeTcFeeRowsForDays(days, [], fallback.rows);
        return persistDailyRows(client, {
          rows: merged.rows,
          days,
          startDate,
          endDate,
          source: 'midgard+cmc+defillama',
          sourceStats: {
            missingDays: merged.missingDays,
            fallback_reason: 'dune_error',
            dune_error: summarizeDuneError(error),
            fallback_earnings_rows: fallback.earningsRows,
            fallback_rune_rows: fallback.runeRows,
            fallback_cmc_rows: fallback.cmcRows,
            fallback_dex_rows: fallback.dexRows,
            ...(fallback.dexError ? { fallback_dex_error: fallback.dexError } : {})
          }
        });
      } catch (fallbackError) {
        return markDuneBackfillSkipped(client, syncState, {
          error,
          fallbackError,
          startDate,
          endDate: days.at(-1),
          dayCount
        });
      }
    }

    if (isRateLimitError(error)) {
      const until = await putCooldown(client, error);
      return {
        skipped: true,
        reason: 'rate_limited',
        rate_limited_until: until,
        error: error.message || String(error)
      };
    }
    throw error;
  }
}

export const tcFeeDashIngestionConstants = Object.freeze({
  BILLION,
  DAY_MS,
  SYNC_KEY
});
