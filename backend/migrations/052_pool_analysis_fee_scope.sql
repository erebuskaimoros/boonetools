begin;

alter table public.pool_analysis_daily
  drop column if exists pool_earnings_rune_e8;

delete from public.pool_analysis_daily
where volume_rune_e8 is null
  and volume_usd_e2 is null
  and fees_rune_e8 is null;

update public.pool_analysis_daily
set source = 'liquify-midgard-swaps'
where source in ('liquify-midgard-history', 'liquify-midgard-earnings');

comment on table public.pool_analysis_daily is
  'Per-pool UTC swap volume and pool-generated liquidity fees. RUNE values use 1e8 base units and USD volume uses cents; downstream system-income distribution is outside this dataset.';

commit;
