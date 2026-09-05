const DAILY_COLUMNS = [
  'asset', 'day', 'volume_rune_e8', 'volume_usd_e2', 'fees_rune_e8',
  'rune_price_usd', 'interval_start', 'interval_end', 'partial', 'source', 'completed_at'
];

export async function upsertPoolAnalysisDays(client, rows = [], options = {}) {
  if (!rows.length) return 0;
  const payload = rows.map((row) => Object.fromEntries(
    DAILY_COLUMNS.map((column) => [column, row?.[column] ?? null])
  ));
  const result = await client.query(
    `insert into pool_analysis_daily as current (${DAILY_COLUMNS.join(', ')})
     select incoming.asset, incoming.day, incoming.volume_rune_e8,
            incoming.volume_usd_e2, incoming.fees_rune_e8,
            incoming.rune_price_usd, incoming.interval_start,
            incoming.interval_end, incoming.partial, incoming.source, incoming.completed_at
     from jsonb_to_recordset($1::jsonb) as incoming (
       asset text, day date, volume_rune_e8 numeric, volume_usd_e2 numeric,
       fees_rune_e8 numeric, rune_price_usd numeric, interval_start timestamptz,
       interval_end timestamptz, partial boolean, source text, completed_at timestamptz
     )
     on conflict (asset, day) do update set
       volume_rune_e8 = excluded.volume_rune_e8,
       volume_usd_e2 = excluded.volume_usd_e2,
       fees_rune_e8 = excluded.fees_rune_e8,
       rune_price_usd = excluded.rune_price_usd,
       interval_start = excluded.interval_start,
       interval_end = excluded.interval_end,
       partial = excluded.partial,
       source = excluded.source,
       completed_at = excluded.completed_at,
       observed_at = now(),
       updated_at = now()
     where current.completed_at is null
        or ($2::boolean and excluded.completed_at is not null)`,
    [JSON.stringify(payload), Boolean(options.force)]
  );
  return result.rowCount ?? rows.length;
}

export async function loadPoolAnalysisCoverage(client, asset = null) {
  const { rows } = await client.query(
    `select asset, min(day) as first_day, max(day) as last_day,
            count(*)::integer as observed_days, max(updated_at) as source_updated_at
     from pool_analysis_daily
     where ($1::text is null or asset = $1)
     group by asset
     order by asset`,
    [asset]
  );
  return asset ? rows[0] || null : rows;
}

export async function loadPoolAnalysisAggregates(client, completedDay, periods = []) {
  const periodIds = periods.map((period) => String(period.id));
  const periodDays = periods.map((period) => Number(period.days));
  const { rows } = await client.query(
    `with periods as (
       select period_id, period_days
       from unnest($2::text[], $3::integer[]) as requested(period_id, period_days)
     )
     select daily.asset, periods.period_id, periods.period_days,
            min(daily.day) filter (
              where daily.day between $1::date - (periods.period_days - 1) * interval '1 day'
                and $1::date
            ) as first_day,
            max(daily.day) filter (
              where daily.day between $1::date - (periods.period_days - 1) * interval '1 day'
                and $1::date
            ) as last_day,
            count(*) filter (
              where daily.day between $1::date - (periods.period_days - 1) * interval '1 day'
                and $1::date
                and not daily.partial
                and daily.volume_rune_e8 is not null
                and daily.fees_rune_e8 is not null
            )::integer as observed_days,
            sum(daily.volume_rune_e8) filter (
              where daily.day between $1::date - (periods.period_days - 1) * interval '1 day'
                and $1::date and not daily.partial
            )::text as volume_rune_e8,
            sum(daily.volume_usd_e2) filter (
              where daily.day between $1::date - (periods.period_days - 1) * interval '1 day'
                and $1::date and not daily.partial
            ) / 100::numeric as volume_usd,
            sum(daily.fees_rune_e8) filter (
              where daily.day between $1::date - (periods.period_days - 1) * interval '1 day'
                and $1::date and not daily.partial
            )::text as fees_rune_e8,
            sum((daily.fees_rune_e8 / 100000000::numeric) * daily.rune_price_usd) filter (
              where daily.day between $1::date - (periods.period_days - 1) * interval '1 day'
                and $1::date and not daily.partial
            ) as fees_usd,
            max(daily.updated_at) as source_updated_at
     from pool_analysis_daily daily
     cross join periods
     group by daily.asset, periods.period_id, periods.period_days
     order by daily.asset, periods.period_days`,
    [completedDay, periodIds, periodDays]
  );
  return rows;
}

export async function loadPoolAnalysisSeries(client, asset) {
  const { rows } = await client.query(
    `select coalesce(swaps.day, depth.day) as day,
            swaps.volume_rune_e8::text, swaps.volume_usd_e2::text,
            swaps.fees_rune_e8::text, swaps.rune_price_usd::text,
            swaps.partial, coalesce(swaps.source, 'missing') as source,
            depth.rune_depth_e8::text, depth.asset_depth_e8::text,
            depth.asset_price_usd::text, depth.partial as depth_partial,
            depth.source as depth_source, depth.observed_at as depth_updated_at
     from (select * from pool_analysis_daily where asset = $1) swaps
     full outer join (select * from pool_analysis_depth_daily where asset = $1) depth
       on swaps.day = depth.day
     order by day
     limit 5000`,
    [asset]
  );
  return rows;
}

export async function upsertPoolAnalysisDepthDays(client, rows = [], options = {}) {
  if (!rows.length) return 0;
  const { rowCount } = await client.query(
    `insert into pool_analysis_depth_daily as current (
       asset, day, rune_depth_e8, asset_depth_e8, asset_price_usd,
       interval_end, partial, source, completed_at, observed_at
     )
     select asset, day, rune_depth_e8, asset_depth_e8, asset_price_usd,
            interval_end, partial, source, completed_at, coalesce(observed_at, now())
     from jsonb_to_recordset($1::jsonb) as incoming (
       asset text, day date, rune_depth_e8 numeric, asset_depth_e8 numeric,
       asset_price_usd numeric, interval_end timestamptz, partial boolean,
       source text, completed_at timestamptz, observed_at timestamptz
     )
     on conflict (asset, day) do update set
       rune_depth_e8 = excluded.rune_depth_e8,
       asset_depth_e8 = excluded.asset_depth_e8,
       asset_price_usd = excluded.asset_price_usd,
       interval_end = excluded.interval_end,
       partial = excluded.partial,
       source = excluded.source,
       completed_at = excluded.completed_at,
       observed_at = excluded.observed_at,
       updated_at = now()
     where current.completed_at is null
        or ($2::boolean and excluded.completed_at is not null)`,
    [JSON.stringify(rows), Boolean(options.force)]
  );
  return rowCount ?? rows.length;
}

export async function loadPoolAnalysisPendingDays(client, { assets, startDate, today }) {
  // Seed once from known pool history, never from dates before a pool existed.
  // A newly discovered pool starts today; older discovery is explicit backfill.
  await client.query(
    `insert into pool_analysis_refresh_state (asset, lane, first_tracked_day)
     select requested.asset, lane,
            greatest($2::date, coalesce(first_observed.day, $3::date))
     from unnest($1::text[]) as requested(asset)
     cross join (values ('swaps'), ('depth')) as lanes(lane)
     left join lateral (
       select min(day) as day from (
         select min(day) as day from pool_analysis_daily where asset = requested.asset
         union all
         select min(day) from pool_analysis_depth_daily where asset = requested.asset
       ) observations
     ) first_observed on true
     on conflict (asset, lane) do nothing`,
    [assets, startDate, today]
  );
  const { rows } = await client.query(
    `with observations as (
       select asset, 'swaps'::text as lane, day, completed_at from pool_analysis_daily where asset = any($1::text[])
       union all
       select asset, 'depth', day, completed_at from pool_analysis_depth_daily where asset = any($1::text[])
     ), expected as (
       select state.asset, state.lane, day::date
       from pool_analysis_refresh_state state
       cross join lateral generate_series(state.first_tracked_day::timestamp, ($2::date - 1)::timestamp, interval '1 day') as days(day)
       where state.asset = any($1::text[])
     ), pending as (
       select expected.asset, expected.lane, expected.day
       from expected left join observations using (asset, lane, day)
       where observations.completed_at is null
       union
       select asset, lane, day from observations
       where day < $2::date and completed_at is null
     )
     select asset, lane, to_char(day, 'YYYY-MM-DD') as day from pending
     order by day desc, asset, lane`,
    [assets, today]
  );
  return rows;
}

export async function loadPoolAnalysisSyncStates(client) {
  const { rows } = await client.query(
    `select asset, first_day, last_day, last_completed_day, last_error,
            stats_json, updated_at
     from pool_analysis_sync_state
     order by asset`
  );
  return rows;
}

export async function updatePoolAnalysisSyncState(client, state = {}) {
  await client.query(
    `insert into pool_analysis_sync_state (
       asset, first_day, last_day, last_completed_day, last_error, stats_json
     ) values ($1, $2, $3, $4, $5, $6)
     on conflict (asset) do update set
       first_day = least(excluded.first_day, pool_analysis_sync_state.first_day),
       last_day = greatest(excluded.last_day, pool_analysis_sync_state.last_day),
       last_completed_day = greatest(excluded.last_completed_day, pool_analysis_sync_state.last_completed_day),
       last_error = excluded.last_error,
       stats_json = excluded.stats_json,
       updated_at = now()`,
    [
      state.asset,
      state.firstDay || null,
      state.lastDay || null,
      state.lastCompletedDay || null,
      state.lastError || '',
      state.stats || {}
    ]
  );
}

export const POOL_ANALYSIS_ROLLING_NAMESPACE = 'thorchain-mainnet:pool-analysis-rolling:v1';

export async function loadPoolAnalysisCompletedDays(client, asset, cutoff) {
  const { rows } = await client.query(
    `select day, volume_rune_e8::text, volume_usd_e2::text, fees_rune_e8::text,
            rune_price_usd::text, partial, completed_at
     from pool_analysis_daily
     where asset = $1 and day >= ($2::timestamptz at time zone 'UTC')::date - 365
       and day < ($2::timestamptz at time zone 'UTC')::date
     order by day`, [asset, new Date(cutoff * 1000).toISOString()]);
  return rows;
}

export async function savePoolAnalysisRollingSnapshot(client, asset, periods, observedAt) {
  await client.query(
    `insert into source_observations as current
       (namespace, identity, payload_json, source, observed_at, metadata_json)
     values ($1, $2, $3::jsonb, 'liquify-midgard:exact-swaps+completed-days', $4, '{}'::jsonb)
     on conflict (namespace, identity) do update set
       payload_json = excluded.payload_json, observed_at = excluded.observed_at,
       metadata_json = excluded.metadata_json
     where current.observed_at <= excluded.observed_at`,
    [POOL_ANALYSIS_ROLLING_NAMESPACE, asset, JSON.stringify({ periods }), observedAt]);
}

export async function markPoolAnalysisRollingFailure(client, asset, message) {
  // Preserve the successful observation and its timestamp; a failed attempt is never fresh data.
  await client.query(
    `update source_observations set metadata_json = jsonb_build_object('last_error', $3::text)
     where namespace = $1 and identity = $2`, [POOL_ANALYSIS_ROLLING_NAMESPACE, asset, message]);
}

export async function loadPoolAnalysisRollingAggregates(client, asOf, periods = []) {
  const { rows } = await client.query(
    `select payload_json, observed_at, metadata_json from source_observations where namespace = $1`,
    [POOL_ANALYSIS_ROLLING_NAMESPACE]);
  const now = new Date(asOf).getTime();
  const snapshots = rows.flatMap((row) => (Array.isArray(row.payload_json) ? row.payload_json : row.payload_json?.periods || []).map((period) => ({
    ...period,
    stale: period.window_mode === 'rolling' && (Boolean(row.metadata_json?.last_error)
      || now - new Date(row.observed_at).getTime() > 20 * 60 * 1000 || new Date(row.observed_at).getTime() > now),
    refresh_error: row.metadata_json?.last_error || ''
  })));
  if (!periods.length) return snapshots;
  const midnight = Math.floor(now / 86400000) * 86400000;
  const completedDay = new Date(midnight - 86400000).toISOString().slice(0, 10);
  // Preserve existing table totals while the prefix ledger warms, including
  // valid legacy !partial rows which predate explicit completed_at proofs.
  const legacy = await loadPoolAnalysisAggregates(client, completedDay, periods);
  const merged = new Map(legacy.map((row) => {
    const days = Number(row.period_days);
    return [`${row.asset}:${row.period_id}`, { ...row,
      window_mode: 'completed-days', snapshot_ready: false, snapshot_resolution_seconds: 900,
      window_start: new Date(midnight - days * 86400000).toISOString(),
      window_end: new Date(midnight).toISOString(), stale: false,
      incomplete: Number(row.observed_days) < days, usd_fee_estimate: true }];
  }));
  for (const row of snapshots) {
    const key = `${row.asset}:${row.period_id}`;
    if (row.window_mode === 'rolling' || !merged.has(key)) merged.set(key, row);
    else merged.set(key, { ...merged.get(key), snapshot_cutoff: row.snapshot_cutoff, refresh_error: row.refresh_error });
  }
  return [...merged.values()];
}

export async function loadPoolAnalysisRollingEdges(client, asset, cutoff) {
  const { rows } = await client.query(
    `select asset, bucket_end, volume_rune_e8::text, volume_usd_e2::text, fees_rune_e8::text, rune_price_usd::text
     from pool_analysis_intraday_snapshots where asset = $1 and bucket_end = $2`,
    [asset, new Date(cutoff * 1000).toISOString()]);
  const row = rows[0];
  return row ? { asset, cutoff, head: { ...row, day: new Date(cutoff * 1000).toISOString().slice(0, 10),
    interval_start: new Date(Math.floor(cutoff / 86400) * 86400000).toISOString(),
    interval_end: new Date(cutoff * 1000).toISOString(), partial: true } } : null;
}

export async function savePoolAnalysisIntradaySnapshot(client, head) {
  await client.query(
    `insert into pool_analysis_intraday_snapshots
       (asset, bucket_end, volume_rune_e8, volume_usd_e2, fees_rune_e8, rune_price_usd)
     values ($1, $2, $3, $4, $5, $6) on conflict (asset, bucket_end) do nothing`,
    [head.asset, head.interval_end, head.volume_rune_e8, head.volume_usd_e2, head.fees_rune_e8, head.rune_price_usd]);
}

export async function loadPoolAnalysisBoundarySnapshots(client, asset, cutoff, periods) {
  const ends = periods.map((period) => new Date((cutoff - period.days * 86400) * 1000).toISOString());
  const { rows } = await client.query(
    `select bucket_end, volume_rune_e8::text, volume_usd_e2::text, fees_rune_e8::text, rune_price_usd::text
     from pool_analysis_intraday_snapshots where asset = $1 and bucket_end = any($2::timestamptz[])`, [asset, ends]);
  return rows;
}
