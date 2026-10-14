begin;

-- Durable compact finalized observations, independent of the short-lived
-- chain-header cache and of the POL reconciliation/publication lifecycle.
create table if not exists public.financials_reward_blocks (
  height bigint primary key check (height > 0),
  block_time timestamptz not null,
  revshare_e8 numeric(78, 0) not null check (revshare_e8 >= 0),
  reserve_observation jsonb,
  reserve_emissions_e8 numeric(78, 0) check (reserve_emissions_e8 >= 0),
  emissions_method text,
  emissions_evidence jsonb,
  source text not null,
  observed_at timestamptz not null default now()
);

create index if not exists financials_reward_blocks_time_idx
  on public.financials_reward_blocks (block_time, height);

comment on table public.financials_reward_blocks is
  'Finalized per-block REVSHARE payouts and independently verified Reserve emission observations. Missing blocks/fields are not zero; complete interval boundaries are checked before publication.';

commit;
