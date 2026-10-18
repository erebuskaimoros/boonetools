-- Lazy, resumable full-day rankings. Public reads only enqueue; the existing
-- independent Financials collector owns bounded provider acquisition.
create table if not exists financials_day_details (
  day date primary key,
  state_json jsonb,
  payload_json jsonb,
  requested_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_error text
);
create index if not exists financials_day_details_queue on financials_day_details (available_at, requested_at);
