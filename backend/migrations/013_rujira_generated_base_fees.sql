begin;

create table if not exists public.rujira_base_fee_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running', 'success', 'error')),
  error text,
  stats_json jsonb not null default '{}'::jsonb
);

create index if not exists rujira_base_fee_job_runs_job_started_idx
  on public.rujira_base_fee_job_runs (job_name, started_at desc);

create table if not exists public.rujira_base_fee_sync_state (
  sync_key text primary key,
  next_page_token text not null default '',
  complete boolean not null default false,
  rate_limited_until timestamptz,
  updated_at timestamptz not null default now(),
  stats_json jsonb not null default '{}'::jsonb
);

create table if not exists public.rujira_base_fee_actions (
  action_key text primary key,
  height bigint not null,
  action_date timestamptz,
  tx_id text not null default '',
  memo text not null default '',
  status text not null default '',
  raw_action jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now()
);

create index if not exists rujira_base_fee_actions_height_idx
  on public.rujira_base_fee_actions (height desc);

create index if not exists rujira_base_fee_actions_date_idx
  on public.rujira_base_fee_actions (action_date desc);

create table if not exists public.rujira_base_fee_blocks (
  height bigint primary key,
  block_time timestamptz,
  status text not null default 'pending' check (status in ('pending', 'fetched', 'error')),
  attempts integer not null default 0,
  next_retry_at timestamptz not null default now(),
  error text not null default '',
  scan_json jsonb not null default '{}'::jsonb,
  fetched_at timestamptz,
  parsed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rujira_base_fee_blocks_status_retry_idx
  on public.rujira_base_fee_blocks (status, next_retry_at asc, height desc);

create index if not exists rujira_base_fee_blocks_time_idx
  on public.rujira_base_fee_blocks (block_time desc);

create table if not exists public.rujira_base_fee_rune_price_weeks (
  week_start date primary key,
  week_end date not null,
  rune_price_usd double precision not null default 0,
  source_json jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now()
);

create table if not exists public.rujira_base_fee_events (
  event_key text primary key,
  height bigint not null,
  block_time timestamptz,
  swap_id text not null default '',
  pool text not null default '',
  chain text not null default '',
  from_address text not null default '',
  to_address text not null default '',
  coin text not null default '',
  memo text not null default '',
  liquidity_fee_base text not null default '0',
  liquidity_fee_rune double precision not null default 0,
  rune_price_usd double precision not null default 0,
  liquidity_fee_usd double precision not null default 0,
  classification text not null default 'unknown',
  included boolean not null default false,
  source_contract text not null default '',
  source_label text not null default '',
  source_denom text not null default '',
  context_origin text not null default '',
  raw_event jsonb not null default '{}'::jsonb,
  context_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rujira_base_fee_events_included_time_idx
  on public.rujira_base_fee_events (included, block_time desc);

create index if not exists rujira_base_fee_events_height_idx
  on public.rujira_base_fee_events (height desc);

create index if not exists rujira_base_fee_events_classification_idx
  on public.rujira_base_fee_events (classification);

create index if not exists rujira_base_fee_events_source_contract_idx
  on public.rujira_base_fee_events (source_contract);

commit;
