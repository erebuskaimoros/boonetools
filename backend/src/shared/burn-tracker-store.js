const DAY_COLUMNS = [
  'day', 'burn_e8', 'rune_price_usd', 'interval_start', 'interval_end',
  'partial', 'source', 'source_json', 'completed_at'
];

export async function upsertBurnTrackerDays(client, rows = [], options = {}) {
  if (!rows.length) return 0;
  const values = rows.map((row) => Object.fromEntries(
    DAY_COLUMNS.map((column) => [column, row?.[column] ?? null])
  ));
  const result = await client.query(
    `insert into system_income_burn_daily as current (${DAY_COLUMNS.join(', ')})
     select incoming.day, incoming.burn_e8, incoming.rune_price_usd,
            incoming.interval_start, incoming.interval_end, incoming.partial,
            incoming.source, incoming.source_json, incoming.completed_at
     from jsonb_to_recordset($1::jsonb) as incoming (
       day date, burn_e8 numeric, rune_price_usd numeric,
       interval_start timestamptz, interval_end timestamptz,
       partial boolean, source text, source_json jsonb, completed_at timestamptz
     )
     on conflict (day) do update set
       burn_e8 = excluded.burn_e8,
       rune_price_usd = excluded.rune_price_usd,
       interval_start = excluded.interval_start,
       interval_end = excluded.interval_end,
       partial = excluded.partial,
       source = excluded.source,
       source_json = excluded.source_json,
       completed_at = excluded.completed_at,
       observed_at = now(),
       updated_at = now()
     where current.completed_at is null or ($2::boolean and excluded.completed_at is not null)`,
    [JSON.stringify(values), Boolean(options.force)]
  );
  return result.rowCount ?? rows.length;
}

export async function loadBurnTrackerPendingDays(client, startDate, today) {
  const { rows } = await client.query(
    `select to_char(expected.day, 'YYYY-MM-DD') as day
     from generate_series($1::date::timestamp, ($2::date - 1)::timestamp, interval '1 day') expected(day)
     left join system_income_burn_daily observed on observed.day = expected.day::date
     where observed.completed_at is null order by expected.day`, [startDate, today]);
  return rows.map((row) => row.day);
}

export async function loadBurnTrackerTotals(client, startDate, today) {
  const { rows } = await client.query(
    `select count(*) filter (where day < $2::date and completed_at is not null)::integer as completed_days,
       coalesce(sum(burn_e8) filter (where day < $2::date and completed_at is not null), 0)::text as completed_burn_e8,
       max(burn_e8) filter (where day = $2::date)::text as current_burn_e8
     from system_income_burn_daily where day between $1::date and $2::date`, [startDate, today]);
  const row = rows[0] || {};
  const expected = Math.max(0, Math.round((Date.parse(today) - Date.parse(startDate)) / 86400000));
  return { ...row, complete: row.completed_days === expected && /^\d+$/.test(String(row.current_burn_e8 ?? '')) };
}

export async function loadBurnTrackerDays(client, startDate, endDate) {
  const { rows } = await client.query(
    `select day, burn_e8, rune_price_usd, interval_start, interval_end,
            partial, source, observed_at, updated_at
     from system_income_burn_daily
     where day between $1::date and $2::date
     order by day`,
    [startDate, endDate]
  );
  return rows;
}

export async function loadBurnTrackerCoverage(client) {
  const { rows } = await client.query(
    `select min(day) as first_day, max(day) as last_day,
            count(*)::integer as observed_days,
            max(updated_at) as source_updated_at
     from system_income_burn_daily`
  );
  return rows[0] || {};
}

export async function getBurnTrackerSyncState(client, syncKey = 'system-income-burn:v1') {
  const { rows } = await client.query(
    `select sync_key, start_date, next_day, last_completed_day, last_error,
            stats_json, updated_at
     from system_income_burn_sync_state
     where sync_key = $1`,
    [syncKey]
  );
  return rows[0] || null;
}

export async function updateBurnTrackerSyncState(client, state = {}) {
  await client.query(
    `insert into system_income_burn_sync_state (
       sync_key, start_date, next_day, last_completed_day, last_error, stats_json
     ) values ($1, $2, $3, $4, $5, $6)
     on conflict (sync_key) do update set
       start_date = excluded.start_date,
       next_day = excluded.next_day,
       last_completed_day = excluded.last_completed_day,
       last_error = excluded.last_error,
       stats_json = excluded.stats_json,
       updated_at = now()`,
    [
      state.syncKey || 'system-income-burn:v1',
      state.startDate,
      state.nextDay || null,
      state.lastCompletedDay || null,
      state.lastError || '',
      state.stats || {}
    ]
  );
}

export async function loadBurnTrackerLiveOverlay(client, since) {
  const baseline = new Date(since || '');
  if (!Number.isFinite(baseline.getTime())) {
    return { days: [], through_height: 0, through_time: null };
  }
  const increments = await client.query(
    `select (block_time at time zone 'UTC')::date::text as day,
            sum(system_income_burn_e8)::text as burn_e8
     from chain_block_headers
     where block_time > $1::timestamptz
       and system_income_burn_e8 is not null
     group by (block_time at time zone 'UTC')::date
     order by day`,
    [baseline.toISOString()]
  );
  const latest = await client.query(
    `select height::text as height, block_time
     from chain_block_headers
     order by height desc
     limit 1`
  );
  const head = latest.rows[0] || {};
  return {
    days: increments.rows,
    through_height: Math.max(0, Math.trunc(Number(head.height)) || 0),
    through_time: head.block_time || null
  };
}
