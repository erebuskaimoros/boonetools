begin;

create table if not exists public.source_observations (
  namespace text not null,
  identity text not null,
  payload_json jsonb not null,
  source text not null,
  observed_at timestamptz not null,
  expires_at timestamptz,
  completed_at timestamptz,
  metadata_json jsonb not null default '{}'::jsonb,
  primary key (namespace, identity)
);

create index if not exists source_observations_expiry_idx
  on public.source_observations (expires_at) where completed_at is null;

comment on table public.source_observations is
  'Shared raw source observations. Expiry never proves finality; completed observations require caller-verified source evidence and are immutable except explicit validated repair.';

commit;
