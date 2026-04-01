begin;

alter table public.rapid_swaps
  add column if not exists action_height bigint not null default 0;

create index if not exists rapid_swaps_action_height_idx
  on public.rapid_swaps (action_height desc);

create table if not exists public.rapid_swap_candidates (
  hint_key text primary key,
  source text not null default 'ws',
  tx_id text not null default '',
  source_address text not null default '',
  memo text not null default '',
  observed_height bigint not null default 0,
  last_height bigint not null default 0,
  status text not null default 'pending' check (status in ('pending', 'resolved', 'error')),
  attempts integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  next_retry_at timestamptz not null default now(),
  resolved_tx_id text not null default '',
  resolved_at timestamptz,
  last_error text,
  raw_hint jsonb not null default '{}'::jsonb
);

create index if not exists rapid_swap_candidates_status_retry_idx
  on public.rapid_swap_candidates (status, next_retry_at asc);

create index if not exists rapid_swap_candidates_tx_id_idx
  on public.rapid_swap_candidates (tx_id);

create index if not exists rapid_swap_candidates_observed_height_idx
  on public.rapid_swap_candidates (observed_height desc);

create table if not exists public.rapid_swap_sync_state (
  sync_key text primary key,
  last_scanned_height bigint not null default 0,
  last_scanned_at timestamptz,
  stats_json jsonb not null default '{}'::jsonb
);

commit;
