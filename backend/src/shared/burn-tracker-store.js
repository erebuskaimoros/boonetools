const DAY_COLUMNS = [
  'day', 'burn_e8', 'rune_price_usd', 'interval_start', 'interval_end',
  'partial', 'source', 'source_json'
];

export async function upsertBurnTrackerDays(client, rows = []) {
  if (!rows.length) return 0;
  const values = rows.map((row) => Object.fromEntries(
    DAY_COLUMNS.map((column) => [column, row?.[column] ?? null])
  ));
  const result = await client.query(
    `insert into system_income_burn_daily (${DAY_COLUMNS.join(', ')})
     select incoming.day, incoming.burn_e8, incoming.rune_price_usd,
            incoming.interval_start, incoming.interval_end, incoming.partial,
            incoming.source, incoming.source_json
     from jsonb_to_recordset($1::jsonb) as incoming (
       day date, burn_e8 numeric, rune_price_usd numeric,
       interval_start timestamptz, interval_end timestamptz,
       partial boolean, source text, source_json jsonb
     )
     on conflict (day) do update set
       burn_e8 = excluded.burn_e8,
       rune_price_usd = coalesce(excluded.rune_price_usd, system_income_burn_daily.rune_price_usd),
       interval_start = excluded.interval_start,
       interval_end = excluded.interval_end,
       partial = excluded.partial,
       source = excluded.source,
       source_json = excluded.source_json,
       observed_at = now(),
       updated_at = now()`,
    [JSON.stringify(values)]
  );
  return result.rowCount || rows.length;
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
