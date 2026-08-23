begin;

create table if not exists public.system_income_burn_daily (
  day date primary key,
  burn_e8 numeric(78, 0) not null check (burn_e8 >= 0),
  rune_price_usd numeric,
  interval_start timestamptz not null,
  interval_end timestamptz,
  partial boolean not null default false,
  source text not null default 'liquify-midgard-earnings',
  source_json jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists system_income_burn_daily_day_desc_idx
  on public.system_income_burn_daily (day desc);

create table if not exists public.system_income_burn_sync_state (
  sync_key text primary key,
  start_date date not null,
  next_day date,
  last_completed_day date,
  last_error text not null default '',
  stats_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.system_income_burn_daily is
  'UTC daily RUNE burned only through the burn_system_income route. Amounts are 1e8 base units.';

commit;
