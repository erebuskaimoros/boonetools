begin;

create table if not exists public.pool_analysis_intraday_snapshots (
  asset text not null,
  bucket_end timestamptz not null,
  volume_rune_e8 numeric(78, 0) not null check (volume_rune_e8 >= 0),
  volume_usd_e2 numeric(78, 0) not null check (volume_usd_e2 >= 0),
  fees_rune_e8 numeric(78, 0) not null check (fees_rune_e8 >= 0),
  rune_price_usd numeric,
  observed_at timestamptz not null default now(),
  primary key (asset, bucket_end),
  check (mod(extract(epoch from bucket_end), 900) = 0)
);

comment on table public.pool_analysis_intraday_snapshots is
  'Cumulative pool swap volume and liquidity fees from UTC midnight through bucket_end; these are prefixes, never interval deltas. Missing polls are not interpolated.';

commit;
