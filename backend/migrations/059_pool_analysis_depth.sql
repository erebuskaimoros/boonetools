begin;

create table if not exists public.pool_analysis_depth_daily (
  asset text not null,
  day date not null,
  rune_depth_e8 numeric(78, 0),
  asset_depth_e8 numeric(78, 0),
  asset_price_usd numeric,
  interval_end timestamptz,
  partial boolean not null default false,
  source text not null default 'liquify-midgard-depths',
  updated_at timestamptz not null default now(),
  primary key (asset, day),
  check (rune_depth_e8 is null or rune_depth_e8 >= 0),
  check (asset_depth_e8 is null or asset_depth_e8 >= 0),
  check (asset_price_usd is null or asset_price_usd >= 0)
);

comment on table public.pool_analysis_depth_daily is
  'Independent UTC daily closing pool balances and pool asset USD price from Midgard depths. Two-sided USD depth is 2 x asset balance x pool asset price; missing observations are never carried forward.';

commit;
