begin;

alter table public.pol_tracker_daily
  add column if not exists reserve_module_address text,
  add column if not exists reserve_pool_count integer;

alter table public.pol_tracker_pool_daily
  add column if not exists reserve_pol_lp_units numeric(78, 0),
  add column if not exists reserve_pol_rune_e8 numeric(78, 0),
  add column if not exists reserve_pol_usd_e8 numeric(78, 0);

comment on column public.pol_tracker_daily.reserve_module_address is
  'Legacy Reserve module queried for the per-pool POL breakdown.';

comment on column public.pol_tracker_pool_daily.reserve_pol_rune_e8 is
  'Gross Reserve POL value in RUNE: 2 x THORNode rounded safe share(reserve LP units, pool units, RUNE depth) at the daily anchor height.';

comment on column public.pol_tracker_pool_daily.reserve_pol_usd_e8 is
  'Gross per-pool Reserve POL RUNE value converted with the same-height RUNE/TOR price.';

commit;
