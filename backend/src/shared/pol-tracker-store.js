const DAILY_COLUMNS = [
  'day',
  'anchor_height',
  'anchor_block_time',
  'treasury_module_address',
  'rune_price_usd_e8',
  'synth_backing_usd_e8',
  'synth_face_usd_e8',
  'treasury_asset_usd_e8',
  'treasury_rune_usd_e8',
  'treasury_total_usd_e8',
  'reserve_pol_rune_e8',
  'reserve_pol_usd_e8',
  'runepool_provider_owned_rune_e8',
  'pool_count',
  'treasury_pool_count',
  'complete',
  'lane_status',
  'warnings',
  'source'
];

const POOL_COLUMNS = [
  'day', 'asset', 'pool_status', 'asset_price_usd_e8', 'balance_asset_e8',
  'balance_rune_e8', 'pool_units', 'lp_units', 'synth_units', 'synth_supply_e8',
  'synth_backing_usd_e8',
  'synth_face_usd_e8', 'treasury_lp_units', 'treasury_asset_redeem_e8',
  'treasury_rune_redeem_e8', 'treasury_asset_usd_e8', 'treasury_rune_usd_e8',
  'treasury_total_usd_e8'
];

function values(row, columns) {
  return columns.map((column) => row?.[column] ?? null);
}
export async function persistPolTrackerObservation(client, observation) {
  const daily = observation?.daily;
  if (!daily?.day || !Number(daily.anchor_height)) {
    throw new Error('A dated, anchored POL Tracker observation is required');
  }
  const parameters = values(daily, DAILY_COLUMNS);
  const placeholders = DAILY_COLUMNS.map((_, index) => `$${index + 1}`).join(', ');
  const updates = DAILY_COLUMNS.filter((column) => column !== 'day')
    .map((column) => `${column} = excluded.${column}`)
    .concat('updated_at = now()')
    .join(', ');

  await client.query('begin');
  try {
    await client.query(
      `insert into pol_tracker_daily (${DAILY_COLUMNS.join(', ')})
       values (${placeholders})
       on conflict (day) do update set ${updates}`,
      parameters
    );
    await client.query('delete from pol_tracker_pool_daily where day = $1::date', [daily.day]);
    const pools = (Array.isArray(observation.pools) ? observation.pools : [])
      .map((row) => Object.fromEntries(POOL_COLUMNS.map((column) => [column, row?.[column] ?? null])));
    if (pools.length) {
      await client.query(
        `insert into pol_tracker_pool_daily (${POOL_COLUMNS.join(', ')})
         select ${POOL_COLUMNS.map((column) => `incoming.${column}`).join(', ')}
         from jsonb_to_recordset($1::jsonb) as incoming (
           day date, asset text, pool_status text, asset_price_usd_e8 numeric,
           balance_asset_e8 numeric, balance_rune_e8 numeric, pool_units numeric,
           lp_units numeric, synth_units numeric, synth_supply_e8 numeric,
           synth_backing_usd_e8 numeric, synth_face_usd_e8 numeric,
           treasury_lp_units numeric, treasury_asset_redeem_e8 numeric,
           treasury_rune_redeem_e8 numeric, treasury_asset_usd_e8 numeric,
           treasury_rune_usd_e8 numeric, treasury_total_usd_e8 numeric
         )`,
        [JSON.stringify(pools)]
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

export async function loadPolTrackerStoredDays(client, startDate, endDate) {
  const { rows } = await client.query(
    `select day, anchor_height, anchor_block_time, treasury_module_address,
            rune_price_usd_e8, synth_backing_usd_e8,
            synth_face_usd_e8, treasury_total_usd_e8,
            reserve_pol_rune_e8, reserve_pol_usd_e8,
            pool_count, treasury_pool_count, complete, lane_status, warnings,
            source, updated_at
     from pol_tracker_daily
     where day between $1::date and $2::date
     order by day`,
    [startDate, endDate]
  );
  return rows;
}

export async function loadPolTrackerExistingDays(client, startDate, endDate) {
  const { rows } = await client.query(
    `select day, complete
     from pol_tracker_daily
     where day between $1::date and $2::date
     order by day`,
    [startDate, endDate]
  );
  return rows;
}

export async function loadLatestPolTrackerPools(client) {
  const { rows } = await client.query(
    `select day, asset, pool_status, asset_price_usd_e8, synth_units,
            synth_supply_e8,
            synth_backing_usd_e8, synth_face_usd_e8, treasury_lp_units,
            treasury_total_usd_e8
     from pol_tracker_pool_daily
     where day = (select max(day) from pol_tracker_daily)
     order by greatest(
       coalesce(synth_backing_usd_e8, 0),
       coalesce(treasury_total_usd_e8, 0)
     ) desc, asset`,
  );
  return rows;
}

export async function updatePolTrackerSyncState(client, state = {}) {
  await client.query(
    `insert into pol_tracker_sync_state (
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
      state.syncKey || 'pol-tracker-daily:v1',
      state.startDate,
      state.nextDay || null,
      state.lastCompletedDay || null,
      state.lastError || '',
      state.stats || {}
    ]
  );
}
