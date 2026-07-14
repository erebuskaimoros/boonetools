begin;

create table if not exists public.rujira_base_layer_earnings_day_baselines (
  day_start date primary key,
  snapshot_height bigint not null,
  snapshot_time timestamptz not null,
  collector_balances jsonb not null default '{}'::jsonb,
  source text not null default 'thornode-archive',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rujira_base_layer_earnings_daily (
  day_start date primary key,
  day_end date not null,
  snapshot_time timestamptz not null,
  baseline_height bigint not null,
  route_scopes jsonb not null default '[]'::jsonb,
  by_denom jsonb not null default '{}'::jsonb,
  unpriced_denoms jsonb not null default '[]'::jsonb,
  denom_change_count integer not null default 0,
  inventory_delta_usd numeric not null default 0,
  reserve_payout_rune numeric not null default 0,
  reserve_payout_usd numeric not null default 0,
  inflow_usd numeric not null default 0,
  source text not null default 'backend-chain-state',
  updated_at timestamptz not null default now()
);

create index if not exists rujira_base_layer_earnings_daily_snapshot_idx
  on public.rujira_base_layer_earnings_daily (snapshot_time desc);

commit;
