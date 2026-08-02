-- Isolate provider circuit breakers by upstream service and persist reusable
-- same-height THORChain pool/oracle state for historical analytics.
begin;

create table if not exists public.thorchain_market_snapshots (
  height bigint primary key,
  block_time timestamptz not null,
  pools_json jsonb not null,
  oracle_prices_json jsonb not null,
  source text not null default 'thornode-historical',
  observed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists thorchain_market_snapshots_block_time_idx
  on public.thorchain_market_snapshots (block_time desc);

comment on table public.thorchain_market_snapshots is
  'Canonical same-height historical pool and oracle payloads shared by Pool Dislocation and Wasm economics.';

comment on column public.provider_circuit_breakers.provider_key is
  'global:<hostname> for confirmed gateway 429/Retry-After cooldowns; service:<hostname><service-path> for ordinary upstream failures.';

commit;
