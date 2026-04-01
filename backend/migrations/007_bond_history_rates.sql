alter table public.bond_history
  add column if not exists rates_json jsonb;
