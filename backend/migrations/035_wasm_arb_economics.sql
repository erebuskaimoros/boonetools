-- Wasm arb economics read model support.
begin;

create table if not exists public.wasm_arb_economics_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running', 'success', 'error')),
  error text,
  stats_json jsonb not null default '{}'::jsonb
);

create index if not exists wasm_arb_economics_job_runs_started_idx
  on public.wasm_arb_economics_job_runs (job_name, started_at desc);

create table if not exists public.wasm_arb_economics_sync_state (
  sync_key text primary key,
  cursor_value text not null default '',
  next_page_token text not null default '',
  complete boolean not null default false,
  stats_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.wasm_arb_economics_regimes (
  activation_height bigint primary key,
  activation_time timestamptz not null,
  mimir_value integer not null,
  previous_mimir_value integer,
  arb_contract text not null,
  trade_collector text not null,
  base_layer_collector text not null,
  tc_share numeric not null check (tc_share >= 0 and tc_share <= 1),
  source text not null,
  observed_at timestamptz not null default now(),
  metadata_json jsonb not null default '{}'::jsonb
);

create index if not exists wasm_arb_economics_regimes_time_idx
  on public.wasm_arb_economics_regimes (activation_time desc);

insert into public.wasm_arb_economics_regimes (
  activation_height,
  activation_time,
  mimir_value,
  previous_mimir_value,
  arb_contract,
  trade_collector,
  base_layer_collector,
  tc_share,
  source,
  metadata_json
) values (
  27181679,
  '2026-07-27T14:04:45Z',
  0,
  7,
  'thor1n5a08r0zvmqca39ka2tgwlkjy9ugalutk7fjpzptfppqcccnat2ska5t4g',
  'thor1gm8q2gr25nzzsxzdp2mpja4hyvyhjlr4s6krcsgv2y953uu0js3qhwpus7',
  'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr',
  0.5,
  'verified-chain-event',
  '{"change_kind":"mimir","note":"WasmArbSlipMinBps changed from 7 to 0"}'::jsonb
)
on conflict (activation_height) do nothing;

create table if not exists public.wasm_arb_economics_network_buckets (
  bucket_start timestamptz primary key,
  bucket_end timestamptz not null,
  network_volume_usd numeric not null default 0,
  network_liquidity_fee_rune numeric not null default 0,
  network_liquidity_fee_usd numeric not null default 0,
  network_swap_leg_count integer not null default 0,
  rune_price_usd numeric not null default 0,
  source text not null default 'midgard-swap-history',
  source_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists wasm_arb_economics_network_end_idx
  on public.wasm_arb_economics_network_buckets (bucket_end desc);

create table if not exists public.wasm_arb_economics_actions (
  action_key text primary key,
  height bigint not null,
  block_time timestamptz not null,
  tx_id text not null default '',
  leg_count smallint not null check (leg_count in (1, 2)),
  input_volume_usd numeric not null default 0,
  executed_leg_volume_usd numeric not null default 0,
  liquidity_fee_rune numeric not null default 0,
  swap_slip_bps integer not null default 0,
  status text not null default '',
  raw_action jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now()
);

create index if not exists wasm_arb_economics_actions_time_idx
  on public.wasm_arb_economics_actions (block_time desc);

create index if not exists wasm_arb_economics_actions_height_idx
  on public.wasm_arb_economics_actions (height desc);

create table if not exists public.wasm_arb_economics_blocks (
  height bigint primary key,
  block_time timestamptz,
  status text not null default 'pending' check (status in ('pending', 'fetched', 'error')),
  attempts integer not null default 0,
  next_retry_at timestamptz not null default now(),
  error text not null default '',
  source_addresses jsonb not null default '[]'::jsonb,
  event_count integer not null default 0,
  fetched_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists wasm_arb_economics_blocks_pending_idx
  on public.wasm_arb_economics_blocks (status, next_retry_at, height);

create table if not exists public.wasm_arb_economics_rujira_fees (
  event_key text primary key,
  height bigint not null,
  block_time timestamptz not null,
  tx_id text not null default '',
  event_origin text not null default '',
  event_ordinal integer not null default 0,
  source_contract text not null,
  fee_kind text not null check (fee_kind in ('amm', 'fin', 'fin_range')),
  denom text not null,
  amount_base numeric not null,
  amount numeric not null,
  price_usd numeric,
  fee_usd numeric,
  price_source text not null default '',
  wasm_linked boolean not null default false,
  raw_event jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now()
);

create index if not exists wasm_arb_economics_rujira_fees_time_idx
  on public.wasm_arb_economics_rujira_fees (block_time desc);

create index if not exists wasm_arb_economics_rujira_fees_height_idx
  on public.wasm_arb_economics_rujira_fees (height desc);

create index if not exists wasm_arb_economics_rujira_fees_contract_idx
  on public.wasm_arb_economics_rujira_fees (source_contract, fee_kind);

commit;
