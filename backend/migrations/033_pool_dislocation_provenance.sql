begin;

alter table public.pool_dislocation_observations
  add column if not exists sample_origin text not null default 'scheduled',
  add column if not exists thorchain_height bigint,
  add column if not exists pool_price_method text,
  add column if not exists oracle_price_method text,
  add column if not exists binance_price_method text;

update public.pool_dislocation_observations
set pool_price_method = coalesce(pool_price_method, 'thornode-asset-tor'),
    oracle_price_method = case
      when oracle_price_usd is not null then coalesce(oracle_price_method, 'thornode-oracle')
      else oracle_price_method
    end,
    binance_price_method = case
      when binance_price_usd is not null then coalesce(binance_price_method, 'book-ticker-mid')
      else binance_price_method
    end;

alter table public.pool_dislocation_observations
  drop constraint if exists pool_dislocation_sample_origin_check;

alter table public.pool_dislocation_observations
  add constraint pool_dislocation_sample_origin_check
  check (sample_origin in ('scheduled', 'historical_backfill'));

create index if not exists pool_dislocation_origin_observed_idx
  on public.pool_dislocation_observations (sample_origin, observed_at desc);

comment on column public.pool_dislocation_observations.sample_origin is
  'scheduled for live five-minute sampling; historical_backfill for reconstructed history';
comment on column public.pool_dislocation_observations.binance_price_method is
  'book-ticker-mid for live samples; kline-close for the provenance-labelled historical backfill';

commit;
