-- Fee ranking needs every route and every streaming sub-swap, not only the
-- former input-value candidates. Preserve those records, but do not claim
-- complete fee coverage before the new collector begins recording.
alter table financials_swap_ledger add column if not exists fee_started_at timestamptz not null default now();
alter table financials_swap_candidates add column if not exists fee_rune_e8 numeric(78,0) default 0
  check (fee_rune_e8 >= 0);
create index if not exists financials_swap_candidates_start on financials_swap_candidates (first_seen_at, tx_id);

-- One transaction can have two pool legs and many sub-swaps in the same block.
-- They are summed before insertion. The key makes replay/backfill idempotent.
create table if not exists financials_swap_fee_blocks (
  tx_id text not null,
  height bigint not null,
  fee_rune_e8 numeric(78,0) check (fee_rune_e8 >= 0),
  primary key (tx_id, height)
);

-- Retain only unfinished streams and unresolved ranked IDs for each exact
-- window. Closed windows keep their retry path after the recent-day scan rolls
-- forward, without repeatedly ranking every historical day.
create table if not exists financials_swap_verification_windows (
  window_from timestamptz not null,
  window_to timestamptz not null,
  tx_id text not null,
  primary key (window_from, window_to, tx_id)
);
create index if not exists financials_swap_verification_windows_tx
  on financials_swap_verification_windows (tx_id);
