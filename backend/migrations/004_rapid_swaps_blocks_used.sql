alter table public.rapid_swaps
  add column if not exists blocks_used integer not null default 0;
