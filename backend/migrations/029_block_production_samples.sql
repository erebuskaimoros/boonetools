begin;

create table if not exists public.block_production_samples (
  sample_time timestamptz primary key,
  start_height bigint not null,
  end_height bigint not null,
  start_block_time timestamptz not null,
  end_block_time timestamptz not null,
  block_count integer not null default 0,
  seconds_per_block double precision not null default 0,
  source text not null default 'status-dashboard',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists block_production_samples_end_time_idx
  on public.block_production_samples (end_block_time desc);

commit;
