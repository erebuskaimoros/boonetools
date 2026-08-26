begin;

create table if not exists public.pool_analysis_daily (
  asset text not null,
  day date not null,
  volume_rune_e8 numeric(78, 0),
  volume_usd_e2 numeric(78, 0),
  fees_rune_e8 numeric(78, 0),
  rune_price_usd numeric,
  interval_start timestamptz,
  interval_end timestamptz,
  partial boolean not null default false,
  source text not null default 'liquify-midgard-history',
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (asset, day),
  check (volume_rune_e8 is null or volume_rune_e8 >= 0),
  check (volume_usd_e2 is null or volume_usd_e2 >= 0),
  check (fees_rune_e8 is null or fees_rune_e8 >= 0)
);

create index if not exists pool_analysis_daily_day_asset_idx
  on public.pool_analysis_daily (day desc, asset);

create table if not exists public.pool_analysis_sync_state (
  asset text primary key,
  first_day date,
  last_day date,
  last_completed_day date,
  last_error text not null default '',
  stats_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.pool_analysis_daily is
  'Per-pool UTC swap volume and pool-generated liquidity fees. RUNE values use 1e8 base units and USD volume uses cents; downstream system-income distribution is outside this dataset.';

commit;
