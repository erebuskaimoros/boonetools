begin;

create table if not exists public.api_response_cache (
  cache_key text primary key,
  payload_json jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists api_response_cache_expires_at_idx
  on public.api_response_cache (expires_at);

create table if not exists public.bond_tx_events (
  bond_address text not null,
  tx_id text not null,
  action_height bigint not null,
  node_address text not null default '',
  action_type text not null default 'bond',
  raw_action jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (bond_address, tx_id, action_height)
);

create index if not exists bond_tx_events_bond_height_idx
  on public.bond_tx_events (bond_address, action_height asc);

create table if not exists public.bond_tx_event_sync_state (
  bond_address text primary key,
  synced_at timestamptz,
  complete boolean not null default false,
  error text not null default ''
);

commit;
