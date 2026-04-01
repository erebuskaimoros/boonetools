alter table public.bond_history
  add column if not exists user_bond bigint;
