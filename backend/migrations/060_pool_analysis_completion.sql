begin;

-- Existing rows lack an aggregation watermark. Validate them once in bounded
-- scheduler batches before marking them complete; do not infer finality here.
alter table public.pool_analysis_daily add column if not exists completed_at timestamptz;
alter table public.pool_analysis_depth_daily add column if not exists completed_at timestamptz;
alter table public.pool_analysis_depth_daily add column if not exists observed_at timestamptz;
update public.pool_analysis_depth_daily set observed_at = updated_at where observed_at is null;
alter table public.pool_analysis_depth_daily alter column observed_at set default now();
alter table public.pool_analysis_depth_daily alter column observed_at set not null;

create index if not exists pool_analysis_daily_pending_idx
  on public.pool_analysis_daily (asset, day) where completed_at is null;
create index if not exists pool_analysis_depth_daily_pending_idx
  on public.pool_analysis_depth_daily (asset, day) where completed_at is null;

create table if not exists public.pool_analysis_refresh_state (
  asset text not null,
  lane text not null check (lane in ('swaps', 'depth')),
  first_tracked_day date not null,
  primary key (asset, lane)
);
comment on table public.pool_analysis_refresh_state is
  'Durable start of missing-day detection. Never moves with the rolling lookback, so outages cannot age gaps out. Existing incomplete rows before this boundary remain eligible separately.';

commit;
