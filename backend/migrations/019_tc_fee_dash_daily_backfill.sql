begin;

create extension if not exists pgcrypto;

alter table public.tc_fee_dash_windows
  add column if not exists period text not null default 'weekly_seed',
  add column if not exists tc_fees_rune numeric,
  add column if not exists rune_price_usd numeric,
  add column if not exists cmc_volume_24h_usd numeric,
  add column if not exists defillama_dex_volume_usd numeric,
  add column if not exists source_json jsonb not null default '{}'::jsonb,
  add column if not exists fetched_at timestamptz;

create index if not exists tc_fee_dash_windows_period_start_idx
  on public.tc_fee_dash_windows (period, window_start);

create table if not exists public.tc_fee_dash_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running', 'success', 'error')),
  error text,
  stats_json jsonb not null default '{}'::jsonb
);

create index if not exists tc_fee_dash_job_runs_job_started_idx
  on public.tc_fee_dash_job_runs (job_name, started_at desc);

create table if not exists public.tc_fee_dash_sync_state (
  sync_key text primary key,
  start_date date not null,
  next_date date not null,
  end_date date,
  complete boolean not null default false,
  rate_limited_until timestamptz,
  updated_at timestamptz not null default now(),
  stats_json jsonb not null default '{}'::jsonb
);

commit;
