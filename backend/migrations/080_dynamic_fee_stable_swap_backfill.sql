begin;

-- Stable-to-stable swap history for the 90 UTC days before the Financials
-- swap ledger began recording fees, read from Midgard swap actions. It is
-- stored separately so Financials rankings and verification never see it.
create table if not exists public.dynamic_fee_stable_swap_backfill (
  id boolean primary key default true check (id),
  -- First live-ledger day; the scan covers [target_start, ledger_start).
  ledger_start date not null,
  target_start date not null,
  -- Discovered once from /pools: every stable variant except omitted_asset.
  asset_filter jsonb not null default '[]',
  omitted_asset text not null default '',
  -- Day being scanned (newest first), the filter group within it and the
  -- pinned source's opaque cursor. Null scan_day means nothing is left.
  scan_day date,
  group_index integer not null default 0,
  source_base text,
  page_token text not null default '',
  seen_tokens_json jsonb not null default '[]',
  day_actions bigint not null default 0,
  last_error text,
  available_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

-- One row per successful stable-to-stable swap action, keyed like the
-- affiliate actions by its sorted inbound transaction ids.
create table if not exists public.dynamic_fee_stable_swap_backfill_swaps (
  action_key text primary key,
  day date not null,
  action_time bigint not null,
  height bigint not null,
  input_asset text not null,
  input_e8 numeric(78, 0) not null check (input_e8 >= 0),
  output_asset text not null,
  fee_rune_e8 numeric(78, 0) check (fee_rune_e8 >= 0)
);
create index if not exists dynamic_fee_stable_swap_backfill_swaps_day
  on public.dynamic_fee_stable_swap_backfill_swaps (day);

-- A row exists only once every filter group of that day was fully scanned.
create table if not exists public.dynamic_fee_stable_swap_backfill_days (
  day date primary key,
  rune_price_usd numeric check (rune_price_usd > 0),
  actions_scanned bigint not null default 0,
  swaps integer not null default 0,
  completed_at timestamptz not null default now()
);

commit;
