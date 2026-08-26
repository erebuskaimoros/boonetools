const DAILY_COLUMNS = [
  'asset', 'day', 'volume_rune_e8', 'volume_usd_e2', 'fees_rune_e8',
  'rune_price_usd', 'interval_start', 'interval_end', 'partial', 'source'
];

export async function upsertPoolAnalysisDays(client, rows = []) {
  if (!rows.length) return 0;
  const payload = rows.map((row) => Object.fromEntries(
    DAILY_COLUMNS.map((column) => [column, row?.[column] ?? null])
  ));
  const result = await client.query(
    `insert into pool_analysis_daily as current (${DAILY_COLUMNS.join(', ')})
     select incoming.asset, incoming.day, incoming.volume_rune_e8,
            incoming.volume_usd_e2, incoming.fees_rune_e8,
            incoming.rune_price_usd, incoming.interval_start,
            incoming.interval_end, incoming.partial, incoming.source
     from jsonb_to_recordset($1::jsonb) as incoming (
       asset text, day date, volume_rune_e8 numeric, volume_usd_e2 numeric,
       fees_rune_e8 numeric, rune_price_usd numeric, interval_start timestamptz,
       interval_end timestamptz, partial boolean, source text
     )
     on conflict (asset, day) do update set
       volume_rune_e8 = coalesce(excluded.volume_rune_e8, current.volume_rune_e8),
       volume_usd_e2 = coalesce(excluded.volume_usd_e2, current.volume_usd_e2),
       fees_rune_e8 = coalesce(excluded.fees_rune_e8, current.fees_rune_e8),
       rune_price_usd = coalesce(excluded.rune_price_usd, current.rune_price_usd),
       interval_start = coalesce(excluded.interval_start, current.interval_start),
       interval_end = coalesce(excluded.interval_end, current.interval_end),
       partial = excluded.partial,
       source = excluded.source,
       observed_at = now(),
       updated_at = now()`,
    [JSON.stringify(payload)]
  );
  return result.rowCount || rows.length;
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
    `select day, volume_rune_e8::text, volume_usd_e2::text,
            fees_rune_e8::text, rune_price_usd::text, partial, source
     from pool_analysis_daily
     where asset = $1
     order by day
     limit 5000`,
    [asset]
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
       first_day = coalesce(excluded.first_day, pool_analysis_sync_state.first_day),
       last_day = coalesce(excluded.last_day, pool_analysis_sync_state.last_day),
       last_completed_day = coalesce(excluded.last_completed_day, pool_analysis_sync_state.last_completed_day),
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
