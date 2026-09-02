begin;

-- This cursor certifies inspected contract events, not merely repaired headers.
create table if not exists public.app_layer_collector_event_state (
  stream_key text primary key,
  last_height bigint not null default 0,
  last_block_time timestamptz,
  generation bigint not null default 1,
  contiguous_blocks integer not null default 0,
  dirty_heights jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

commit;
