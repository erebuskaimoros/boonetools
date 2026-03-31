begin;

create table if not exists public.rapid_swap_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running', 'success', 'error')),
  error text,
  stats_json jsonb not null default '{}'::jsonb
);

create table if not exists public.rapid_swaps (
  tx_id text primary key,
  action_date timestamptz not null,
  observed_at timestamptz not null default now(),
  memo text not null default '',
  status text not null default 'completed',
  tx_status text not null default '',
  source_asset text not null default '',
  target_asset text not null default '',
  input_amount_base text not null default '0',
  output_amount_base text not null default '0',
  input_estimated_usd double precision not null default 0,
  output_estimated_usd double precision not null default 0,
  liquidity_fee_base text not null default '0',
  swap_slip_bps bigint not null default 0,
  is_limit_order boolean not null default false,
  streaming_interval bigint not null default 0,
  streaming_quantity bigint not null default 0,
  streaming_count bigint not null default 0,
  affiliate text not null default '',
  source_address text not null default '',
  destination_address text not null default '',
  raw_action jsonb not null default '{}'::jsonb
);

create index if not exists rapid_swaps_action_date_idx
  on public.rapid_swaps (action_date desc);

create index if not exists rapid_swaps_input_estimated_usd_idx
  on public.rapid_swaps (input_estimated_usd desc, action_date desc);

create index if not exists rapid_swaps_observed_at_idx
  on public.rapid_swaps (observed_at desc);

commit;
