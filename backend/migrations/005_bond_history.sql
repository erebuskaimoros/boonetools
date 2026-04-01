create table if not exists public.bond_history (
  bond_address text not null,
  churn_height bigint not null,
  churn_timestamp bigint not null,
  rune_stack bigint not null default 0,
  rune_price double precision not null default 0,
  created_at timestamptz not null default now(),
  primary key (bond_address, churn_height)
);

create index if not exists idx_bond_history_address
  on public.bond_history (bond_address, churn_height desc);
