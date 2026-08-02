-- Correct Wasm arb economics fee accounting.
begin;

alter table public.wasm_arb_economics_regimes
  add column if not exists spread_bps integer,
  add column if not exists previous_spread_bps integer;

alter table public.wasm_arb_economics_blocks
  add column if not exists scan_version integer not null default 1,
  add column if not exists fetched_version integer not null default 0;

insert into public.wasm_arb_economics_regimes (
  activation_height,
  activation_time,
  mimir_value,
  previous_mimir_value,
  spread_bps,
  previous_spread_bps,
  arb_contract,
  trade_collector,
  base_layer_collector,
  tc_share,
  source,
  metadata_json
) values (
  27184679,
  '2026-07-27T19:41:02.160668526Z',
  0,
  0,
  3,
  null,
  'thor1n5a08r0zvmqca39ka2tgwlkjy9ugalutk7fjpzptfppqcccnat2ska5t4g',
  'thor1gm8q2gr25nzzsxzdp2mpja4hyvyhjlr4s6krcsgv2y953uu0js3qhwpus7',
  'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr',
  0.5,
  'verified-chain-event',
  '{"change_kind":"spread","tx_hash":"D29F7DD96F27A75991607191FFF9645AA203C7C215CE08634D5ED996C1DDCC7C","note":"Arb contract migrated to code ID 182 and spread_bps set to 3"}'::jsonb
)
on conflict (activation_height) do update set
  activation_time = excluded.activation_time,
  spread_bps = excluded.spread_bps,
  previous_spread_bps = excluded.previous_spread_bps,
  source = excluded.source,
  metadata_json = excluded.metadata_json;

create table if not exists public.wasm_arb_economics_fin_contracts (
  address text primary key,
  code_id bigint not null,
  base_denom text not null default '',
  quote_denom text not null default '',
  config_json jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wasm_arb_economics_fin_contracts_code_idx
  on public.wasm_arb_economics_fin_contracts (code_id, address);

create table if not exists public.wasm_arb_economics_oracle_samples (
  height bigint not null,
  block_time timestamptz not null,
  pool_asset text not null,
  oracle_symbol text not null,
  pool_price_usd numeric not null,
  oracle_price_usd numeric not null,
  signed_deviation_bps numeric not null,
  absolute_deviation_bps numeric not null,
  rune_depth_usd numeric not null,
  source_json jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  primary key (height, pool_asset)
);

create index if not exists wasm_arb_economics_oracle_samples_time_idx
  on public.wasm_arb_economics_oracle_samples (block_time desc);

create index if not exists wasm_arb_economics_oracle_samples_pool_idx
  on public.wasm_arb_economics_oracle_samples (pool_asset, height desc);

-- These tables are derived caches. Rebuild them from canonical Midgard and
-- Tendermint indexes so no pre-correction duplicate volume or incomplete fee
-- discovery can survive beside the corrected rows.
delete from public.wasm_arb_economics_rujira_fees;
delete from public.wasm_arb_economics_blocks;
delete from public.wasm_arb_economics_actions;

delete from public.wasm_arb_economics_sync_state
where sync_key like 'actions:%'
   or sync_key like 'actions-backfill:%'
   or sync_key like 'collector-%'
   or sync_key = 'oracle:backfill';

delete from public.api_read_models
where model_key in ('wasm-arb-economics:v1', 'wasm-arb-economics:v2');

commit;
