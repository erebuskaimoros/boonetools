begin;

create table if not exists public.pol_tracker_daily (
  day date primary key,
  anchor_height bigint not null check (anchor_height > 0),
  anchor_block_time timestamptz not null,
  treasury_module_address text not null,
  rune_price_usd_e8 numeric(78, 0) not null,
  savers_usd_e8 numeric(78, 0),
  synth_backing_usd_e8 numeric(78, 0),
  synth_face_usd_e8 numeric(78, 0),
  treasury_asset_usd_e8 numeric(78, 0),
  treasury_rune_usd_e8 numeric(78, 0),
  treasury_total_usd_e8 numeric(78, 0),
  reserve_pol_rune_e8 numeric(78, 0),
  reserve_pol_usd_e8 numeric(78, 0),
  runepool_reserve_owned_rune_e8 numeric(78, 0),
  runepool_reserve_owned_usd_e8 numeric(78, 0),
  runepool_provider_owned_rune_e8 numeric(78, 0),
  pool_count integer not null default 0,
  treasury_pool_count integer not null default 0,
  complete boolean not null default false,
  lane_status jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  source text not null default 'thornode-same-height',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pol_tracker_daily_day_desc_idx
  on public.pol_tracker_daily (day desc);

create table if not exists public.pol_tracker_pool_daily (
  day date not null references public.pol_tracker_daily(day) on delete cascade,
  asset text not null,
  pool_status text not null default '',
  asset_price_usd_e8 numeric(78, 0),
  balance_asset_e8 numeric(78, 0),
  balance_rune_e8 numeric(78, 0),
  pool_units numeric(78, 0),
  lp_units numeric(78, 0),
  synth_units numeric(78, 0),
  synth_supply_e8 numeric(78, 0),
  savers_depth_e8 numeric(78, 0),
  savers_units numeric(78, 0),
  savers_usd_e8 numeric(78, 0),
  synth_backing_usd_e8 numeric(78, 0),
  synth_face_usd_e8 numeric(78, 0),
  treasury_lp_units numeric(78, 0),
  treasury_asset_redeem_e8 numeric(78, 0),
  treasury_rune_redeem_e8 numeric(78, 0),
  treasury_asset_usd_e8 numeric(78, 0),
  treasury_rune_usd_e8 numeric(78, 0),
  treasury_total_usd_e8 numeric(78, 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (day, asset)
);

create index if not exists pol_tracker_pool_daily_asset_day_idx
  on public.pol_tracker_pool_daily (asset, day desc);

create table if not exists public.pol_tracker_sync_state (
  sync_key text primary key,
  start_date date not null,
  next_day date,
  last_completed_day date,
  last_error text not null default '',
  stats_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.pol_tracker_daily.runepool_provider_owned_rune_e8 is
  'Private reconciliation input. Never publish this provider-owned RUNEPool value in the POL Tracker API.';

commit;
