begin;

create table if not exists public.protocol_mimir_changes (
  event_key text primary key,
  tx_id text not null default '',
  height bigint not null,
  block_time timestamptz,
  event_index integer not null default 0,
  mimir_key text not null,
  mimir_value text not null default '',
  change_source text not null default 'protocol_direct',
  source_label text not null default 'Direct protocol event',
  security_message text not null default '',
  source text not null default 'rpc',
  raw_event jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists protocol_mimir_changes_tx_event_idx
  on public.protocol_mimir_changes (tx_id, event_index)
  where tx_id <> '';

create index if not exists protocol_mimir_changes_key_time_idx
  on public.protocol_mimir_changes (mimir_key, block_time desc nulls last, height desc);

create index if not exists protocol_mimir_changes_height_idx
  on public.protocol_mimir_changes (height desc);

comment on table public.protocol_mimir_changes is
  'Direct protocol set_mimir changes, stored separately from validator set_node_mimir votes.';

commit;
