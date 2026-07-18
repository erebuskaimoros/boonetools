begin;

create table if not exists public.api_read_model_runs (
  id bigserial primary key,
  model_key text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'success', 'error')),
  duration_ms bigint,
  source_watermark timestamptz,
  output_bytes bigint,
  error text,
  stats_json jsonb not null default '{}'::jsonb
);

create index if not exists api_read_model_runs_model_started_idx
  on public.api_read_model_runs (model_key, started_at desc);

create index if not exists api_read_model_runs_started_idx
  on public.api_read_model_runs (started_at);

create index if not exists api_read_model_runs_finished_idx
  on public.api_read_model_runs (finished_at)
  where finished_at is not null;

create table if not exists public.api_read_models (
  model_key text primary key,
  schema_version integer not null default 1 check (schema_version > 0),
  payload_json jsonb not null,
  etag text not null,
  generated_at timestamptz not null,
  source_updated_at timestamptz,
  fresh_until timestamptz not null,
  published_at timestamptz not null default now(),
  run_id bigint references public.api_read_model_runs(id) on delete set null,
  metadata_json jsonb not null default '{}'::jsonb
);

create index if not exists api_read_models_fresh_until_idx
  on public.api_read_models (fresh_until);

commit;
