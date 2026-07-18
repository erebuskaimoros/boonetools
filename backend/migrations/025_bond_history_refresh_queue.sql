begin;

create table if not exists public.bond_history_refresh_queue (
  bond_address text not null,
  scope text not null check (scope in ('current', 'historical')),
  include_bond_txs boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  attempts integer not null default 0,
  requested_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (bond_address, scope)
);

create index if not exists bond_history_refresh_queue_ready_idx
  on public.bond_history_refresh_queue (status, available_at, requested_at);

commit;
