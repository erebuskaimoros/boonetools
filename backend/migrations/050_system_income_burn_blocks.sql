begin;

alter table public.chain_block_headers
  add column if not exists system_income_burn_e8 numeric(78, 0)
    check (system_income_burn_e8 is null or system_income_burn_e8 >= 0);

create index if not exists chain_block_headers_live_burn_idx
  on public.chain_block_headers (block_time desc)
  where system_income_burn_e8 is not null;

comment on column public.chain_block_headers.system_income_burn_e8 is
  'Exact per-block RUNE burn from the THORChain rewards income_burn finalize-block attribute, in 1e8 base units.';

commit;
