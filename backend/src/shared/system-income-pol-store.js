import { config } from '../lib/config.js';

export const SYSTEM_INCOME_POL_STATE_KEY = 'system-income-pol:v1';

function iso(value) {
  const parsed = new Date(value || '');
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export async function saveSystemIncomePolBlocks(client, blocks = []) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  const rows = blocks.map((row) => ({
    height: Math.max(1, Math.trunc(Number(row.height)) || 1),
    block_time: iso(row.blockTime ?? row.block_time),
    reward_e8: row.rewardE8 ?? row.reward_e8 ?? null,
    system_income_e8: row.systemIncomeE8 ?? row.system_income_e8 ?? null,
    deployments: row.deployments || [],
    pool_fees: row.poolFees ?? row.pool_fees ?? [],
    source: String(row.source || 'liquify-ws')
  }));
  const result = await client.query(
    `insert into system_income_pol_blocks as current (
       height, block_time, reward_e8, system_income_e8, deployments, pool_fees, source
     )
     select incoming.height, incoming.block_time, incoming.reward_e8, incoming.system_income_e8,
            incoming.deployments, incoming.pool_fees, incoming.source
     from jsonb_to_recordset($1::jsonb) as incoming (
       height bigint, block_time timestamptz, reward_e8 numeric, system_income_e8 numeric,
       deployments jsonb, pool_fees jsonb, source text
     )
     on conflict (height) do update set
       block_time = excluded.block_time,
       reward_e8 = excluded.reward_e8,
       system_income_e8 = excluded.system_income_e8,
       deployments = excluded.deployments,
       pool_fees = excluded.pool_fees,
       source = case when excluded.source = 'liquify-ws' then excluded.source else current.source end,
       updated_at = now()`,
    [JSON.stringify(rows)]
  );
  return result.rowCount || rows.length;
}

export async function saveSystemIncomePolBlock(client, block) {
  return saveSystemIncomePolBlocks(client, [block]);
}

export async function compactSystemIncomePolEvents(client, options = {}) {
  const activationHeight = Math.max(
    1,
    Math.trunc(Number(options.activationHeight)) || config.systemIncomePolActivationHeight
  );
  // Pin one durable ledger watermark for the whole compaction. The listener can
  // append another block between these statements; that block must remain in
  // the handler's `height > live.through_height` overlay instead of advancing
  // the published watermark past data that the daily query did not include.
  const latest = await client.query(
    `select height::text, block_time
     from system_income_pol_blocks
     where height >= $1
     order by height desc
     limit 1`,
    [activationHeight]
  );
  const head = latest.rows[0] || {};
  const throughHeight = Math.max(0, Math.trunc(Number(head.height)) || 0);
  if (throughHeight < activationHeight) {
    return { days: 0, poolDays: 0, throughHeight: 0 };
  }
  const daily = await client.query(
    `with source as (
       select height, block_time,
              coalesce(reward_e8, 0) as funded_e8,
              system_income_e8,
              deployments
       from system_income_pol_blocks
       where height >= $1 and height <= $2
     ), aggregated as (
       select (block_time at time zone 'UTC')::date as day,
              sum(funded_e8) as funded_e8,
              case when count(*) filter (where system_income_e8 is null) > 0 then null
                   else sum(system_income_e8) end as system_income_e8,
              coalesce(sum((select sum(coalesce(item->>'runeE8', item->>'rune_e8')::numeric)
                            from jsonb_array_elements(coalesce(deployments, '[]'::jsonb)) item)), 0) as deployed_e8,
              case when count(*) filter (where exists (
                select 1 from jsonb_array_elements(deployments) item
                where coalesce(item->>'unitsE8', item->>'units_e8') is null
              )) > 0 then null
              else coalesce(sum((select sum(coalesce(item->>'unitsE8', item->>'units_e8')::numeric)
                                 from jsonb_array_elements(coalesce(deployments, '[]'::jsonb)) item)), 0)
              end as minted_units_e8,
              min(height) as first_height, max(height) as last_height,
              count(*)::integer as observed_blocks,
              (max(height) - min(height) + 1)::integer as expected_blocks,
              max(block_time) as source_updated_at
       from source
       group by (block_time at time zone 'UTC')::date
     )
     insert into system_income_pol_daily as current (
       day, funded_e8, system_income_e8, deployed_e8, minted_units_e8, first_height, last_height,
       observed_blocks, expected_blocks, partial, source_updated_at
     )
     select day, funded_e8, system_income_e8, deployed_e8, minted_units_e8, first_height, last_height,
            observed_blocks, expected_blocks,
            observed_blocks < expected_blocks or day = (now() at time zone 'UTC')::date,
            source_updated_at
     from aggregated
     on conflict (day) do update set
       funded_e8 = excluded.funded_e8,
       system_income_e8 = excluded.system_income_e8,
       deployed_e8 = excluded.deployed_e8,
       minted_units_e8 = excluded.minted_units_e8,
       first_height = excluded.first_height,
       last_height = excluded.last_height,
       observed_blocks = excluded.observed_blocks,
       expected_blocks = excluded.expected_blocks,
       partial = excluded.partial,
       source_updated_at = excluded.source_updated_at,
       updated_at = now()
     returning day`,
    [activationHeight, throughHeight]
  );

  const pools = await client.query(
    `with deployments as (
       select (blocks.block_time at time zone 'UTC')::date as day,
              item->>'asset' as asset,
              coalesce(item->>'runeE8', item->>'rune_e8')::numeric as rune_e8,
              coalesce(item->>'unitsE8', item->>'units_e8') as units_e8,
              blocks.block_time
       from system_income_pol_blocks blocks
       cross join lateral jsonb_array_elements(
         coalesce(blocks.deployments, '[]'::jsonb)
       ) item
       where blocks.height >= $1 and blocks.height <= $2
     ), aggregated as (
       select asset, day, sum(rune_e8) as deployed_e8,
              case when count(*) filter (where units_e8 is null) > 0 then null
                   else sum(units_e8::numeric) end as minted_units_e8,
              max(block_time) as source_updated_at
       from deployments
       where asset <> ''
       group by asset, day
     )
     insert into system_income_pol_pool_daily as current (
       asset, day, deployed_e8, minted_units_e8, partial, source_updated_at
     )
     select asset, day, deployed_e8, minted_units_e8,
            day = (now() at time zone 'UTC')::date, source_updated_at
     from aggregated
     on conflict (asset, day) do update set
       deployed_e8 = excluded.deployed_e8,
       minted_units_e8 = excluded.minted_units_e8,
       partial = excluded.partial,
       source_updated_at = greatest(current.source_updated_at, excluded.source_updated_at),
       updated_at = now()
     returning asset, day`,
    [activationHeight, throughHeight]
  );
  await updateSystemIncomePolState(client, {
    activationHeight,
    lastEventHeight: head.height,
    eventsUpdatedAt: head.block_time,
    stats: { compacted_days: daily.rowCount || 0, compacted_pool_days: pools.rowCount || 0 }
  });
  return { days: daily.rowCount || 0, poolDays: pools.rowCount || 0, throughHeight };
}

export async function saveSystemIncomePolPositions(client, positions = [], meta = {}) {
  const rows = Array.isArray(positions) ? positions : [];
  const positionStats = (count) => ({
    positions: count,
    pol_reserve_system_income_bps: Math.max(
      0,
      Math.trunc(Number(meta.polReserveSystemIncomeBps)) || 0
    )
  });
  if (rows.length) {
    const result = await client.query(
      `insert into system_income_pol_positions as current (
         asset, module_address, units_e8, pool_units_e8, rune_deposited_e8,
         rune_held_e8, asset_held_e8, asset_value_rune_e8, position_value_rune_e8,
         balance_rune_e8, balance_asset_e8, asset_tor_price_e8,
         rolling_liquidity_fee_rune_e8, status, observed_height, observed_at
       )
       select incoming.asset, incoming.module_address, incoming.units_e8,
              incoming.pool_units_e8, incoming.rune_deposited_e8,
              incoming.rune_held_e8, incoming.asset_held_e8,
              incoming.asset_value_rune_e8, incoming.position_value_rune_e8,
              incoming.balance_rune_e8, incoming.balance_asset_e8,
              incoming.asset_tor_price_e8, incoming.rolling_liquidity_fee_rune_e8,
              incoming.status, incoming.observed_height, incoming.observed_at
       from jsonb_to_recordset($1::jsonb) as incoming (
         asset text, module_address text, units_e8 numeric, pool_units_e8 numeric,
         rune_deposited_e8 numeric, rune_held_e8 numeric, asset_held_e8 numeric,
         asset_value_rune_e8 numeric, position_value_rune_e8 numeric,
         balance_rune_e8 numeric, balance_asset_e8 numeric, asset_tor_price_e8 numeric,
         rolling_liquidity_fee_rune_e8 numeric, status text,
         observed_height bigint, observed_at timestamptz
       )
       on conflict (asset) do update set
         module_address = excluded.module_address,
         units_e8 = excluded.units_e8,
         pool_units_e8 = excluded.pool_units_e8,
         rune_deposited_e8 = excluded.rune_deposited_e8,
         rune_held_e8 = excluded.rune_held_e8,
         asset_held_e8 = excluded.asset_held_e8,
         asset_value_rune_e8 = excluded.asset_value_rune_e8,
         position_value_rune_e8 = excluded.position_value_rune_e8,
         balance_rune_e8 = excluded.balance_rune_e8,
         balance_asset_e8 = excluded.balance_asset_e8,
         asset_tor_price_e8 = excluded.asset_tor_price_e8,
         rolling_liquidity_fee_rune_e8 = excluded.rolling_liquidity_fee_rune_e8,
         status = excluded.status,
         observed_height = excluded.observed_height,
         observed_at = excluded.observed_at,
         updated_at = now()
       returning asset`,
      [JSON.stringify(rows)]
    );
    await client.query(
      `insert into system_income_pol_position_samples (
         asset, observed_height, observed_at, units_e8, pool_units_e8,
         position_value_rune_e8, position_value_seeded
       )
       select incoming.asset, incoming.observed_height, incoming.observed_at,
              incoming.units_e8, incoming.pool_units_e8,
              incoming.position_value_rune_e8, false
       from jsonb_to_recordset($1::jsonb) as incoming (
         asset text, observed_height bigint, observed_at timestamptz,
         units_e8 numeric, pool_units_e8 numeric, position_value_rune_e8 numeric
       )
       on conflict (asset, observed_height) do update set
         observed_at = excluded.observed_at,
         units_e8 = excluded.units_e8,
         pool_units_e8 = excluded.pool_units_e8,
         position_value_rune_e8 = excluded.position_value_rune_e8,
         position_value_seeded = false`,
      [JSON.stringify(rows)]
    );
    await client.query(
      'delete from system_income_pol_positions where not (asset = any($1::text[]))',
      [rows.map((row) => row.asset)]
    );
    await updateSystemIncomePolState(client, {
      activationHeight: meta.activationHeight,
      moduleAddress: meta.moduleAddress,
      undeployedRuneE8: meta.undeployedRuneE8,
      runePriceUsdE8: meta.runePriceUsdE8,
      positionsUpdatedAt: meta.observedAt,
      stats: positionStats(result.rowCount || rows.length)
    });
    return result.rowCount || rows.length;
  }

  await client.query('delete from system_income_pol_positions');
  await updateSystemIncomePolState(client, {
    activationHeight: meta.activationHeight,
    moduleAddress: meta.moduleAddress,
    undeployedRuneE8: meta.undeployedRuneE8,
    runePriceUsdE8: meta.runePriceUsdE8,
    positionsUpdatedAt: meta.observedAt,
    stats: positionStats(0)
  });
  return 0;
}

export async function refreshSystemIncomePolFeeEstimates(client, options = {}) {
  const now = iso(options.now) || new Date().toISOString();
  const result = await client.query(
    `with bounds as (
       select coalesce(
                (select min(hour) from system_income_pol_pool_hourly
                 where position_value_rune_e8 is null),
                (select max(hour) - interval '2 hours' from system_income_pol_pool_hourly),
                date_trunc('hour', (select min(block_time) from system_income_pol_blocks))
              ) as start_hour,
              date_trunc('hour', $1::timestamptz) as end_hour
     ), assets as (
       select item->>'asset' as asset, min(blocks.block_time) as deployed_at
       from system_income_pol_blocks blocks
       cross join lateral jsonb_array_elements(coalesce(blocks.deployments, '[]'::jsonb)) item
       where coalesce(item->>'asset', '') <> ''
       group by item->>'asset'
     ), hours as (
       select assets.asset, assets.deployed_at, generated.hour
       from assets cross join bounds
       cross join lateral generate_series(
         greatest(bounds.start_hour, date_trunc('hour', assets.deployed_at)),
         bounds.end_hour,
         interval '1 hour'
       ) generated(hour)
       where bounds.start_hour is not null
     ), raw_fees as (
       select item->>'asset' as asset,
              date_trunc('hour', blocks.block_time) as hour,
              sum(coalesce(item->>'feeE8', item->>'fee_e8')::numeric) as pool_fees_e8,
              max(blocks.block_time) as source_updated_at
       from system_income_pol_blocks blocks
       cross join bounds
       cross join lateral jsonb_array_elements(coalesce(blocks.pool_fees, '[]'::jsonb)) item
       where blocks.block_time >= bounds.start_hour
         and blocks.block_time <= $1::timestamptz
         and coalesce(item->>'asset', '') <> ''
       group by item->>'asset', date_trunc('hour', blocks.block_time)
     ), sampled as (
       select samples.asset, date_trunc('hour', samples.observed_at) as hour,
              avg(samples.units_e8 / nullif(samples.pool_units_e8, 0)) as share,
              avg(samples.position_value_rune_e8) as position_value_rune_e8,
              bool_or(samples.position_value_seeded) as position_value_seeded,
              max(samples.observed_at) as source_updated_at
       from system_income_pol_position_samples samples
       cross join bounds
       where samples.observed_at >= bounds.start_hour
         and samples.observed_at <= $1::timestamptz
         and samples.pool_units_e8 > 0
       group by samples.asset, date_trunc('hour', samples.observed_at)
     ), attributed as (
       select hours.asset, hours.hour,
              coalesce(raw_fees.pool_fees_e8, 0) as pool_fees_e8,
              coalesce(sampled.share, seed.share) as share,
              sampled.share is null and seed.share is not null as used_seed,
              coalesce(sampled.position_value_rune_e8, seed.position_value_rune_e8)
                as position_value_rune_e8,
              coalesce(sampled.position_value_seeded, seed.position_value_seeded, false)
                or (sampled.position_value_rune_e8 is null and seed.position_value_rune_e8 is not null)
                as position_value_seeded,
              hours.hour = date_trunc('hour', $1::timestamptz) as provisional,
              greatest(raw_fees.source_updated_at, sampled.source_updated_at,
                seed.source_updated_at, hours.deployed_at) as source_updated_at
       from hours
       left join raw_fees using (asset, hour)
       left join sampled using (asset, hour)
       left join lateral (
         select anchor.units_e8 / nullif(anchor.pool_units_e8, 0) as share,
                anchor.position_value_rune_e8,
                anchor.position_value_seeded,
                anchor.observed_at as source_updated_at
         from system_income_pol_position_samples anchor
         where anchor.asset = hours.asset and anchor.pool_units_e8 > 0
         order by
           case when anchor.observed_at <= hours.hour + interval '1 hour' then 0 else 1 end,
           case when anchor.observed_at <= hours.hour + interval '1 hour'
             then extract(epoch from hours.hour + interval '1 hour' - anchor.observed_at)
             else extract(epoch from anchor.observed_at - hours.hour)
           end
         limit 1
       ) seed on sampled.share is null or sampled.position_value_rune_e8 is null
     ), estimates as (
       select asset, hour, pool_fees_e8, position_value_rune_e8,
              position_value_seeded,
              case when share is null then null else floor(pool_fees_e8 * share) end as estimated_fees_e8,
              case when share is null then null else share * 1000000 end as fee_share_ppm,
              case when share is null then 'unavailable'
                   when provisional then 'partial'
                   when used_seed then 'seeded'
                   else 'complete' end as fee_coverage,
              provisional,
              case when used_seed then 'system-income-pol-block-fees:seeded-ownership'
                   else 'system-income-pol-block-fees:hourly-ownership' end as source,
              source_updated_at
       from attributed
     )
     insert into system_income_pol_pool_hourly as current (
       asset, hour, pool_fees_e8, estimated_fees_e8, position_value_rune_e8,
       position_value_seeded, fee_share_ppm, fee_coverage, provisional, source,
       source_updated_at
     )
     select asset, hour, pool_fees_e8, estimated_fees_e8, position_value_rune_e8,
            position_value_seeded, fee_share_ppm, fee_coverage, provisional, source,
            source_updated_at
     from estimates
     on conflict (asset, hour) do update set
       pool_fees_e8 = excluded.pool_fees_e8,
       estimated_fees_e8 = excluded.estimated_fees_e8,
       position_value_rune_e8 = excluded.position_value_rune_e8,
       position_value_seeded = excluded.position_value_seeded,
       fee_share_ppm = excluded.fee_share_ppm,
       fee_coverage = excluded.fee_coverage,
       provisional = excluded.provisional,
       source = excluded.source,
       source_updated_at = excluded.source_updated_at,
       updated_at = now()
     returning asset, hour, source_updated_at`,
    [now]
  );
  const sourceTimes = result.rows
    .map((row) => Date.parse(row.source_updated_at || ''))
    .filter(Number.isFinite);
  const sourceUpdatedAt = sourceTimes.length
    ? new Date(Math.max(...sourceTimes)).toISOString()
    : null;
  await updateSystemIncomePolState(client, {
    activationHeight: options.activationHeight,
    feesUpdatedAt: sourceUpdatedAt,
    stats: { fee_rows: result.rowCount || 0 }
  });
  return { rows: result.rowCount || 0, sourceUpdatedAt };
}

export async function updateSystemIncomePolState(client, input = {}) {
  const activationHeight = Math.max(
    1,
    Math.trunc(Number(input.activationHeight)) || config.systemIncomePolActivationHeight
  );
  await client.query(
    `insert into system_income_pol_state as current (
       state_key, module_address, undeployed_rune_e8, rune_price_usd_e8, activation_height,
       last_event_height, events_updated_at, positions_updated_at,
       fees_updated_at, last_error, stats_json
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     on conflict (state_key) do update set
       module_address = case when excluded.module_address <> '' then excluded.module_address else current.module_address end,
       undeployed_rune_e8 = coalesce(excluded.undeployed_rune_e8, current.undeployed_rune_e8),
       rune_price_usd_e8 = coalesce(excluded.rune_price_usd_e8, current.rune_price_usd_e8),
       activation_height = least(current.activation_height, excluded.activation_height),
       last_event_height = greatest(current.last_event_height, excluded.last_event_height),
       events_updated_at = coalesce(excluded.events_updated_at, current.events_updated_at),
       positions_updated_at = coalesce(excluded.positions_updated_at, current.positions_updated_at),
       fees_updated_at = coalesce(excluded.fees_updated_at, current.fees_updated_at),
       last_error = excluded.last_error,
       stats_json = current.stats_json || excluded.stats_json,
       updated_at = now()`,
    [
      SYSTEM_INCOME_POL_STATE_KEY,
      String(input.moduleAddress || ''),
      input.undeployedRuneE8 ?? null,
      input.runePriceUsdE8 ?? null,
      activationHeight,
      Math.max(0, Math.trunc(Number(input.lastEventHeight)) || 0),
      iso(input.eventsUpdatedAt),
      iso(input.positionsUpdatedAt),
      iso(input.feesUpdatedAt),
      String(input.lastError || ''),
      JSON.stringify(input.stats || {})
    ]
  );
}

export async function loadSystemIncomePolDaily(client) {
  const { rows } = await client.query(
    `select day::text as day, funded_e8::text, system_income_e8::text,
            deployed_e8::text, minted_units_e8::text,
            first_height::text, last_height::text, observed_blocks, expected_blocks,
            partial, source_updated_at
     from system_income_pol_daily order by day`
  );
  return rows;
}

export async function loadSystemIncomePolPoolDaily(client) {
  const { rows } = await client.query(
    `select asset, day::text as day, deployed_e8::text, minted_units_e8::text,
            estimated_fees_e8::text, fee_share_ppm::text, fee_coverage,
            partial, source_updated_at
     from system_income_pol_pool_daily order by day, asset`
  );
  return rows;
}

export async function loadSystemIncomePolPoolHourly(client) {
  const { rows } = await client.query(
    `select asset, hour, pool_fees_e8::text, estimated_fees_e8::text,
            position_value_rune_e8::text, position_value_seeded,
            fee_share_ppm::text, fee_coverage, provisional, source, source_updated_at
     from system_income_pol_pool_hourly order by hour, asset`
  );
  return rows;
}

export async function loadSystemIncomePolPositions(client) {
  const { rows } = await client.query(
    `select asset, module_address, units_e8::text, pool_units_e8::text,
            rune_deposited_e8::text, rune_held_e8::text, asset_held_e8::text,
            asset_value_rune_e8::text, position_value_rune_e8::text,
            balance_rune_e8::text, balance_asset_e8::text,
            asset_tor_price_e8::text, rolling_liquidity_fee_rune_e8::text,
            status, observed_height::text, observed_at
     from system_income_pol_positions order by rune_deposited_e8 desc, asset`
  );
  return rows;
}

export async function getSystemIncomePolState(client) {
  const { rows } = await client.query(
    `select state_key, module_address, undeployed_rune_e8::text, rune_price_usd_e8::text,
            activation_height::text, last_event_height::text,
            events_updated_at, positions_updated_at, fees_updated_at,
            last_error, stats_json, updated_at
     from system_income_pol_state where state_key = $1`,
    [SYSTEM_INCOME_POL_STATE_KEY]
  );
  return rows[0] || null;
}

export async function loadSystemIncomePolLiveOverlay(client, afterHeight) {
  const baselineHeight = Math.max(0, Math.trunc(Number(afterHeight)) || 0);
  const { rows } = await client.query(
    `select height::text, block_time, system_income_total_e8::text,
            system_income_pol_reward_e8::text,
            system_income_pol_deployments
     from chain_block_headers
     where height > $1::bigint and system_income_pol_observed
     order by height`,
    [baselineHeight]
  );
  let reward = 0n;
  let systemIncome = 0n;
  let systemIncomeComplete = true;
  const byAsset = new Map();
  for (const row of rows) {
    reward += BigInt(row.system_income_pol_reward_e8 || '0');
    if (row.system_income_total_e8 == null) systemIncomeComplete = false;
    else systemIncome += BigInt(row.system_income_total_e8);
    for (const item of Array.isArray(row.system_income_pol_deployments)
      ? row.system_income_pol_deployments : []) {
      const asset = String(item.asset || '');
      if (!asset) continue;
      const current = byAsset.get(asset) || { asset, rune_e8: 0n, units_e8: 0n, units_known: true };
      current.rune_e8 += BigInt(item.runeE8 ?? item.rune_e8 ?? '0');
      const units = item.unitsE8 ?? item.units_e8;
      if (units == null) current.units_known = false;
      else current.units_e8 += BigInt(units);
      byAsset.set(asset, current);
    }
  }
  const latest = rows.at(-1) || {};
  return {
    reward_e8: reward.toString(),
    system_income_e8: systemIncomeComplete ? systemIncome.toString() : null,
    deployments: [...byAsset.values()].map((row) => ({
      asset: row.asset,
      rune_e8: row.rune_e8.toString(),
      units_e8: row.units_known ? row.units_e8.toString() : null
    })),
    through_height: Number(latest.height) || baselineHeight,
    through_time: latest.block_time || null
  };
}
