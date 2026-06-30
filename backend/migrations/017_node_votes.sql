begin;

create table if not exists public.node_vote_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  error text,
  stats_json jsonb not null default '{}'::jsonb
);

create index if not exists node_vote_job_runs_job_started_idx
  on public.node_vote_job_runs (job_name, started_at desc);

create table if not exists public.node_vote_sync_state (
  sync_key text primary key,
  start_height bigint not null default 0,
  last_scanned_height bigint not null default 0,
  end_height bigint not null default 0,
  start_time timestamptz,
  end_time timestamptz,
  complete boolean not null default false,
  updated_at timestamptz not null default now(),
  stats_json jsonb not null default '{}'::jsonb
);

create table if not exists public.node_votes (
  event_key text primary key,
  tx_id text not null default '',
  height bigint not null,
  block_time timestamptz,
  event_index integer not null default 0,
  node_address text not null,
  node_operator_address text not null default '',
  node_status text not null default '',
  mimir_key text not null,
  vote_value text not null default '',
  vote_value_numeric numeric,
  source text not null default 'backfill',
  raw_event jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists node_votes_tx_event_idx
  on public.node_votes (tx_id, event_index)
  where tx_id <> '';

create index if not exists node_votes_time_idx
  on public.node_votes (block_time desc nulls last, height desc);

create index if not exists node_votes_height_idx
  on public.node_votes (height desc);

create index if not exists node_votes_key_time_idx
  on public.node_votes (mimir_key, block_time desc nulls last, height desc);

create index if not exists node_votes_node_time_idx
  on public.node_votes (node_address, block_time desc nulls last, height desc);

create index if not exists node_votes_operator_time_idx
  on public.node_votes (node_operator_address, block_time desc nulls last, height desc);

commit;
