alter table public.bond_history
  add column if not exists scope text not null default 'legacy';

alter table public.bond_history
  drop constraint if exists bond_history_pkey;

alter table public.bond_history
  add constraint bond_history_pkey primary key (bond_address, scope, churn_height);

drop index if exists idx_bond_history_address;

create index if not exists idx_bond_history_address_scope
  on public.bond_history (bond_address, scope, churn_height desc);
