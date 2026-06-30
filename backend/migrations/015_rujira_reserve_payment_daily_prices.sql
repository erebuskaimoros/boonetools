begin;

create table if not exists public.rujira_reserve_payment_rune_price_days (
  day_start date primary key,
  day_end date,
  rune_price_usd numeric not null default 0,
  source_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

commit;
