begin;

create table if not exists public.system_income_pol_pool_hourly (
  asset text not null,
  hour timestamptz not null,
  pool_fees_e8 numeric(78, 0) not null default 0 check (pool_fees_e8 >= 0),
  estimated_fees_e8 numeric(78, 0) check (estimated_fees_e8 is null or estimated_fees_e8 >= 0),
  fee_share_ppm numeric check (fee_share_ppm is null or fee_share_ppm >= 0),
  fee_coverage text not null default 'unavailable'
    check (fee_coverage in ('unavailable', 'seeded', 'partial', 'complete')),
  provisional boolean not null default true,
  source text not null default 'system-income-pol-block-fees',
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (asset, hour)
);

create index if not exists system_income_pol_pool_hourly_hour_idx
  on public.system_income_pol_pool_hourly (hour desc, asset);

comment on table public.system_income_pol_pool_hourly is
  'Hourly SIPOL fee estimates seeded from durable per-block pool fees and ownership samples. The open UTC hour remains provisional.';

comment on table public.system_income_pol_position_samples is
  'Durable ownership checkpoints used for hourly SIPOL fee attribution; a nearest checkpoint seeds hours before continuous coverage began.';

commit;
