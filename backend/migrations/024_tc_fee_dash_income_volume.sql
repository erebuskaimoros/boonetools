begin;

alter table public.tc_fee_dash_windows
  add column if not exists thorchain_volume_usd numeric;

commit;
