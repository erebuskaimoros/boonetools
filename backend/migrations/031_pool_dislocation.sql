begin;

create table if not exists public.pool_dislocation_observations (
  observed_at timestamptz not null,
  asset text not null,
  symbol text not null,
  chain text not null,
  pool_status text not null,
  pool_price_usd numeric,
  pool_balance_asset numeric,
  pool_balance_rune numeric,
  oracle_symbol text,
  oracle_price_usd numeric,
  oracle_observed_at timestamptz,
  binance_symbol text,
  binance_bid_usd numeric,
  binance_ask_usd numeric,
  binance_price_usd numeric,
  binance_observed_at timestamptz,
  source_skew_ms integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (observed_at, asset)
);

create index if not exists pool_dislocation_asset_observed_idx
  on public.pool_dislocation_observations (asset, observed_at desc);

create index if not exists pool_dislocation_observed_idx
  on public.pool_dislocation_observations (observed_at desc);

commit;
