begin;

alter table public.chain_block_headers
  add column if not exists system_income_total_e8 numeric(78, 0)
    check (system_income_total_e8 is null or system_income_total_e8 >= 0);

alter table public.system_income_pol_blocks
  add column if not exists system_income_e8 numeric(78, 0)
    check (system_income_e8 is null or system_income_e8 >= 0);

alter table public.system_income_pol_daily
  add column if not exists system_income_e8 numeric(78, 0)
    check (system_income_e8 is null or system_income_e8 >= 0);

alter table public.system_income_pol_state
  add column if not exists rune_price_usd_e8 numeric(78, 0)
    check (rune_price_usd_e8 is null or rune_price_usd_e8 >= 0);

create index if not exists system_income_pol_blocks_income_repair_idx
  on public.system_income_pol_blocks (height)
  where system_income_e8 is null;

comment on column public.chain_block_headers.system_income_total_e8 is
  'Exact distributable system income reconstructed from every numeric rewards allocation in the finalized block event.';
comment on column public.system_income_pol_blocks.system_income_e8 is
  'Exact post-REVSHARE system income for the block before downstream reward allocations, in 1e8 RUNE base units.';
comment on column public.system_income_pol_state.rune_price_usd_e8 is
  'Current THORNode rune_price_in_tor captured with the two-minute SIPOL position reconciliation.';

commit;
