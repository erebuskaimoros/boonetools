begin;

alter table public.pol_tracker_daily
  add column if not exists system_income_pol_module_address text,
  add column if not exists system_income_pol_rune_e8 numeric(78, 0)
    check (system_income_pol_rune_e8 is null or system_income_pol_rune_e8 >= 0),
  add column if not exists system_income_pol_usd_e8 numeric(78, 0)
    check (system_income_pol_usd_e8 is null or system_income_pol_usd_e8 >= 0),
  add column if not exists system_income_pol_pool_count integer
    check (system_income_pol_pool_count is null or system_income_pol_pool_count >= 0);

alter table public.pol_tracker_pool_daily
  add column if not exists system_income_pol_lp_units numeric(78, 0)
    check (system_income_pol_lp_units is null or system_income_pol_lp_units >= 0),
  add column if not exists system_income_pol_rune_e8 numeric(78, 0)
    check (system_income_pol_rune_e8 is null or system_income_pol_rune_e8 >= 0),
  add column if not exists system_income_pol_usd_e8 numeric(78, 0)
    check (system_income_pol_usd_e8 is null or system_income_pol_usd_e8 >= 0);

comment on column public.pol_tracker_daily.system_income_pol_module_address is
  'The pol_reserve module queried at the same daily anchor height for System Income POL.';

comment on column public.pol_tracker_pool_daily.system_income_pol_rune_e8 is
  'System Income POL two-sided LP position value in RUNE at the daily anchor height.';

comment on column public.pol_tracker_pool_daily.system_income_pol_usd_e8 is
  'System Income POL position value converted with the same-height RUNE/TOR price.';

commit;
