begin;

-- Existing successful reads lack an aggregation watermark; validate each once.
alter table public.system_income_burn_daily add column if not exists completed_at timestamptz;
create index if not exists system_income_burn_daily_pending_idx
  on public.system_income_burn_daily (day) where completed_at is null;

-- A bounded, exhaustively read Midgard window is distinct from its matching
-- actions and from a successful Dune seed. Interrupted windows keep their offset.
alter table public.bond_tx_event_sync_state
  add column if not exists midgard_scanned_through timestamptz,
  add column if not exists midgard_source_key text,
  add column if not exists midgard_scan_json jsonb not null default '{}'::jsonb,
  add column if not exists dune_seeded_at timestamptz;

commit;
