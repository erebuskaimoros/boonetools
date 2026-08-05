begin;

create table if not exists public.chain_block_headers (
  height bigint primary key check (height > 0),
  block_hash text not null default '',
  block_time timestamptz not null,
  interval_ms integer check (interval_ms is null or interval_ms >= 0),
  has_swap_events boolean not null default false,
  source text not null default 'liquify-ws',
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chain_block_headers_time_idx
  on public.chain_block_headers (block_time desc);

create table if not exists public.chain_stream_state (
  stream_key text primary key,
  last_seen_height bigint not null default 0,
  last_seen_block_time timestamptz,
  last_repair_height bigint not null default 0,
  last_repair_at timestamptz,
  stats_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.chain_block_headers is
  'Raw THORChain block headers retained for replayable per-block timing and live site events';

comment on column public.chain_block_headers.interval_ms is
  'Timestamp delta from the immediately preceding height; null when the predecessor is missing';

commit;
