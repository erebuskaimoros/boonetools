begin;

create table if not exists public.provider_circuit_breakers (
  provider_key text primary key,
  failure_count integer not null default 0,
  last_status integer not null default 0,
  last_error text not null default '',
  last_failed_at timestamptz,
  last_success_at timestamptz,
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists provider_circuit_breakers_blocked_until_idx
  on public.provider_circuit_breakers (blocked_until)
  where blocked_until is not null;

create table if not exists public.stuck_transaction_lookup_cache (
  tx_id text not null,
  lookup_type text not null check (lookup_type in ('status', 'details')),
  queue_fingerprint text not null,
  payload_json jsonb not null,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tx_id, lookup_type)
);

create index if not exists stuck_transaction_lookup_cache_updated_idx
  on public.stuck_transaction_lookup_cache (updated_at);

commit;
