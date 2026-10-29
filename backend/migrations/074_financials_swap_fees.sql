-- Liquidity fees for Financials day-detail swap rows stored before ranked rows
-- carried feeRune. The collector fills each transaction once from Midgard; a
-- null fee was checked and had no successful swap with a fee. Reads join by
-- transaction ID, so payload and state JSON, which the day queue rewrites
-- concurrently, are never edited.
create table if not exists financials_swap_fees (
  tx_id text primary key,
  fee_rune_e8 numeric(78, 0) check (fee_rune_e8 >= 0),
  checked_at timestamptz not null default now()
);
