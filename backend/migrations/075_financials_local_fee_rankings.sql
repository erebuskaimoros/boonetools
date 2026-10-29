-- Fee rankings have their own versioned cache. Do not reinterpret an old
-- input-volume top ten as the highest-fee swaps or discard its checkpoints.
-- Keeping the former table intact also permits an older release to roll back.
create table if not exists financials_day_rankings (
  day date not null,
  time_zone text not null default 'UTC',
  window_start timestamptz,
  window_end timestamptz,
  state_json jsonb,
  payload_json jsonb,
  requested_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_error text,
  background boolean not null default false,
  last_worked_at timestamptz,
  primary key (day, time_zone)
);
create index if not exists financials_day_rankings_queue
  on financials_day_rankings (background, last_worked_at, available_at);
