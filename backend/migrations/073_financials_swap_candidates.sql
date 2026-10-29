-- Finalized-block swap candidates for Financials day rankings. The listener and
-- reward repair write them in the same statement as each reward block; only a
-- day's top candidates are verified against Midgard by transaction ID. Deploys
-- stop services before migrating, so a UTC day starting at or after started_at
-- is fully covered. Earlier days keep the Midgard actions scan.
create table if not exists financials_swap_ledger (
  id boolean primary key default true check (id),
  started_at timestamptz not null default now()
);
insert into financials_swap_ledger default values on conflict do nothing;

-- A stream has a start record (its first sub-swap, estimated) and a completion
-- record (its deposit); a single swap is both. The start owns first_height,
-- first_seen_at and day, else the completion block does; the completion owns the
-- size. day is replaced by Midgard's action date once verified. updated_at
-- records the verifier's last completed check, not stream merges.
create table if not exists financials_swap_candidates (
  tx_id text primary key,
  day date not null,
  first_height bigint not null,
  first_seen_at timestamptz not null,
  input_asset text not null,
  input_e8 numeric(78, 0) not null check (input_e8 >= 0),
  rune_value_e8 numeric(78, 0) not null check (rune_value_e8 >= 0),
  output_asset text not null default '',
  streaming boolean not null,
  started boolean not null,
  complete boolean not null,
  completed_at timestamptz,
  status text not null default 'observed' check (status in ('observed', 'pending', 'verified', 'excluded')),
  verified_row jsonb,
  checks integer not null default 0,
  next_check_at timestamptz,
  last_error text not null default '',
  updated_at timestamptz not null default now()
);
create index if not exists financials_swap_candidates_rank on financials_swap_candidates (day, rune_value_e8 desc);
