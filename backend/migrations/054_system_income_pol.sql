begin;

alter table public.chain_block_headers
  add column if not exists system_income_pol_observed boolean not null default false,
  add column if not exists system_income_pol_reward_e8 numeric(78, 0)
    check (system_income_pol_reward_e8 is null or system_income_pol_reward_e8 >= 0),
  add column if not exists system_income_pol_deployments jsonb,
  add column if not exists system_income_pol_pool_fees jsonb;

create index if not exists chain_block_headers_system_income_pol_repair_idx
  on public.chain_block_headers (height)
  where not system_income_pol_observed;

create index if not exists chain_block_headers_system_income_pol_live_idx
  on public.chain_block_headers (block_time desc)
  where system_income_pol_reward_e8 is not null
     or system_income_pol_deployments is not null;

create table if not exists public.system_income_pol_blocks (
  height bigint primary key check (height > 0),
  block_time timestamptz not null,
  reward_e8 numeric(78, 0) check (reward_e8 is null or reward_e8 >= 0),
  deployments jsonb not null default '[]'::jsonb,
  pool_fees jsonb not null default '[]'::jsonb,
  source text not null,
  observed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists system_income_pol_blocks_time_idx
  on public.system_income_pol_blocks (block_time desc);

create table if not exists public.system_income_pol_daily (
  day date primary key,
  funded_e8 numeric(78, 0) not null default 0 check (funded_e8 >= 0),
  deployed_e8 numeric(78, 0) not null default 0 check (deployed_e8 >= 0),
  minted_units_e8 numeric(78, 0) check (minted_units_e8 is null or minted_units_e8 >= 0),
  first_height bigint,
  last_height bigint,
  observed_blocks integer not null default 0,
  expected_blocks integer not null default 0,
  partial boolean not null default true,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.system_income_pol_pool_daily (
  asset text not null,
  day date not null,
  deployed_e8 numeric(78, 0) not null default 0 check (deployed_e8 >= 0),
  minted_units_e8 numeric(78, 0) check (minted_units_e8 is null or minted_units_e8 >= 0),
  estimated_fees_e8 numeric(78, 0) check (estimated_fees_e8 is null or estimated_fees_e8 >= 0),
  fee_share_ppm numeric,
  fee_coverage text not null default 'unavailable',
  partial boolean not null default true,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (asset, day)
);

create index if not exists system_income_pol_pool_daily_day_idx
  on public.system_income_pol_pool_daily (day desc, asset);

create table if not exists public.system_income_pol_positions (
  asset text primary key,
  module_address text not null,
  units_e8 numeric(78, 0) not null check (units_e8 >= 0),
  pool_units_e8 numeric(78, 0) not null check (pool_units_e8 >= 0),
  rune_deposited_e8 numeric(78, 0) not null check (rune_deposited_e8 >= 0),
  rune_held_e8 numeric(78, 0) not null check (rune_held_e8 >= 0),
  asset_held_e8 numeric(78, 0) not null check (asset_held_e8 >= 0),
  asset_value_rune_e8 numeric(78, 0) not null check (asset_value_rune_e8 >= 0),
  position_value_rune_e8 numeric(78, 0) not null check (position_value_rune_e8 >= 0),
  balance_rune_e8 numeric(78, 0) not null check (balance_rune_e8 >= 0),
  balance_asset_e8 numeric(78, 0) not null check (balance_asset_e8 >= 0),
  asset_tor_price_e8 numeric(78, 0) not null check (asset_tor_price_e8 >= 0),
  rolling_liquidity_fee_rune_e8 numeric(78, 0) not null check (rolling_liquidity_fee_rune_e8 >= 0),
  status text not null default '',
  observed_height bigint not null check (observed_height > 0),
  observed_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.system_income_pol_position_samples (
  asset text not null,
  observed_height bigint not null check (observed_height > 0),
  observed_at timestamptz not null,
  units_e8 numeric(78, 0) not null check (units_e8 >= 0),
  pool_units_e8 numeric(78, 0) not null check (pool_units_e8 >= 0),
  primary key (asset, observed_height)
);

create index if not exists system_income_pol_position_samples_time_idx
  on public.system_income_pol_position_samples (asset, observed_at desc);

create table if not exists public.system_income_pol_state (
  state_key text primary key,
  module_address text not null default '',
  undeployed_rune_e8 numeric(78, 0) check (undeployed_rune_e8 is null or undeployed_rune_e8 >= 0),
  activation_height bigint not null,
  last_event_height bigint not null default 0,
  events_updated_at timestamptz,
  positions_updated_at timestamptz,
  fees_updated_at timestamptz,
  last_error text not null default '',
  stats_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.chain_block_headers.system_income_pol_reward_e8 is
  'Exact per-block RUNE sent to pol_reserve by rewards.pol_reserve_reward, in 1e8 base units.';
comment on column public.chain_block_headers.system_income_pol_deployments is
  'Per-block pol_reserve_deploy events paired to internal add_liquidity minted units.';
comment on column public.chain_block_headers.system_income_pol_pool_fees is
  'Raw per-pool swap liquidity_fee_in_rune totals captured for live fee coverage; ownership attribution is performed separately.';
comment on table public.system_income_pol_blocks is
  'Durable idempotent per-height SIPOL event ledger. Unlike chain_block_headers, rows are not retention-pruned.';
comment on table public.system_income_pol_position_samples is
  'Short-retention ownership checkpoints used to time-weight SIPOL share of canonical Pool Analysis fees.';

commit;
