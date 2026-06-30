begin;

create table if not exists public.rujira_reserve_payment_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  error text,
  stats_json jsonb not null default '{}'::jsonb
);

create index if not exists rujira_reserve_payment_job_runs_job_started_idx
  on public.rujira_reserve_payment_job_runs (job_name, started_at desc);

create table if not exists public.rujira_reserve_payment_sync_state (
  sync_key text primary key,
  next_page_token text not null default '',
  next_scheduled_height bigint not null default 0,
  complete boolean not null default false,
  rate_limited_until timestamptz,
  updated_at timestamptz not null default now(),
  stats_json jsonb not null default '{}'::jsonb
);

create table if not exists public.rujira_reserve_payment_blocks (
  height bigint primary key,
  block_time timestamptz,
  source text not null default 'scheduled',
  status text not null default 'pending' check (status in ('pending', 'fetched', 'error')),
  attempts integer not null default 0,
  next_retry_at timestamptz not null default now(),
  error text not null default '',
  scan_json jsonb not null default '{}'::jsonb,
  fetched_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists rujira_reserve_payment_blocks_status_retry_idx
  on public.rujira_reserve_payment_blocks (status, next_retry_at asc, height asc);

create index if not exists rujira_reserve_payment_blocks_time_idx
  on public.rujira_reserve_payment_blocks (block_time desc);

create table if not exists public.rujira_reserve_payment_rune_price_weeks (
  week_start date primary key,
  week_end date,
  rune_price_usd numeric not null default 0,
  source_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.rujira_reserve_payment_events (
  event_key text primary key,
  height bigint not null,
  block_time timestamptz not null,
  tx_id text not null default '',
  sender text not null,
  recipient text not null,
  memo text not null default 'RESERVE',
  amount_base numeric(40,0) not null default 0,
  amount_rune numeric not null default 0,
  rune_price_usd numeric not null default 0,
  amount_usd numeric not null default 0,
  coin text not null default '',
  source text not null default 'ws',
  raw_event jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rujira_reserve_payment_events_time_idx
  on public.rujira_reserve_payment_events (block_time desc);

create index if not exists rujira_reserve_payment_events_height_idx
  on public.rujira_reserve_payment_events (height desc);

create index if not exists rujira_reserve_payment_events_tx_idx
  on public.rujira_reserve_payment_events (tx_id);

commit;
