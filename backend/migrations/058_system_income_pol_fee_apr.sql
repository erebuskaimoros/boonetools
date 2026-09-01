begin;

alter table public.system_income_pol_position_samples
  add column if not exists position_value_rune_e8 numeric(78, 0)
    check (position_value_rune_e8 is null or position_value_rune_e8 >= 0),
  add column if not exists position_value_seeded boolean not null default false;

update public.system_income_pol_position_samples as samples
set position_value_rune_e8 = positions.position_value_rune_e8,
    position_value_seeded = true
from public.system_income_pol_positions as positions
where positions.asset = samples.asset
  and samples.position_value_rune_e8 is null;

alter table public.system_income_pol_pool_hourly
  add column if not exists position_value_rune_e8 numeric(78, 0)
    check (position_value_rune_e8 is null or position_value_rune_e8 >= 0),
  add column if not exists position_value_seeded boolean not null default false;

comment on column public.system_income_pol_position_samples.position_value_rune_e8 is
  'Redeemable SIPOL LP position value in RUNE at this reconciliation checkpoint.';

comment on column public.system_income_pol_position_samples.position_value_seeded is
  'True when an older checkpoint was initialized from the deployment-time current position value.';

comment on column public.system_income_pol_pool_hourly.position_value_rune_e8 is
  'Average SIPOL position value in RUNE used as the capital-hours denominator for estimated fee APR.';

commit;
