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
