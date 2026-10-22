-- Collector-owned UTC-day rankings survive visitor departure and midnight.
-- Existing rows remain visitor-driven until the collector adopts today or an
-- already-started yesterday. No historical scans or checkpoints are reset.
alter table financials_day_details add column if not exists background boolean not null default false;
alter table financials_day_details add column if not exists last_worked_at timestamptz;

create index if not exists financials_day_details_roster_queue
  on financials_day_details (background, last_worked_at, available_at);
