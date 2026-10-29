-- Pool attribution starts with this release. Never infer it from old route fees
-- or acquire pre-release history when someone opens a pool's day details.
alter table financials_swap_ledger add column pool_started_at timestamptz not null default now();

create table financials_pool_swap_blocks (
  height bigint primary key,
  block_time timestamptz not null,
  attribution_complete boolean not null
);
create index financials_pool_swap_blocks_time on financials_pool_swap_blocks(block_time, height);

create table financials_swap_pool_fee_blocks (
  tx_id text not null,
  asset text not null,
  height bigint not null,
  fee_rune_e8 numeric(78,0) not null check (fee_rune_e8 >= 0),
  primary key (tx_id, asset, height)
);
create table financials_swap_pool_fees (
  tx_id text not null,
  asset text not null,
  fee_rune_e8 numeric(78,0) not null check (fee_rune_e8 >= 0),
  primary key (asset, tx_id)
);
create index financials_swap_pool_fees_tx on financials_swap_pool_fees(tx_id);

-- These exact windows share the existing bounded transaction-ID verifier.
-- They never enqueue an actions/history scan. Captured fees and candidate
-- metadata remain durable after the window closes, including late settlement.
create table financials_pool_swap_windows (
  asset text not null,
  day date not null,
  time_zone text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  requested_at timestamptz not null default now(),
  primary key (asset, day, time_zone)
);
