begin;

-- Binance XUSDT books and klines are denominated in USDT, while the original
-- observation columns were labelled as USD. Preserve the provider values in a
-- one-time archive before correcting the public observation table.
create table if not exists public.pool_dislocation_binance_usdt_archive (
  observed_at timestamptz not null,
  asset text not null,
  binance_symbol text not null,
  binance_bid_usdt numeric,
  binance_ask_usdt numeric,
  binance_price_usdt numeric,
  binance_observed_at timestamptz,
  source_price_method text,
  sample_origin text not null,
  thorchain_height bigint,
  usdt_usd_rate numeric,
  usdt_oracle_observed_at timestamptz,
  conversion_status text check (
    conversion_status in ('converted', 'unaligned', 'unavailable')
  ),
  archived_at timestamptz not null default now(),
  primary key (observed_at, asset)
);

comment on table public.pool_dislocation_binance_usdt_archive is
  'Original Binance XUSDT quote values preserved before migration 042 converted them to USD';

insert into public.pool_dislocation_binance_usdt_archive (
  observed_at,
  asset,
  binance_symbol,
  binance_bid_usdt,
  binance_ask_usdt,
  binance_price_usdt,
  binance_observed_at,
  source_price_method,
  sample_origin,
  thorchain_height
)
select observed_at,
       asset,
       binance_symbol,
       binance_bid_usd,
       binance_ask_usd,
       binance_price_usd,
       binance_observed_at,
       binance_price_method,
       sample_origin,
       thorchain_height
from public.pool_dislocation_observations
where upper(binance_symbol) like '%USDT'
  and (
    binance_bid_usd is not null
    or binance_ask_usd is not null
    or binance_price_usd is not null
  )
  and coalesce(binance_price_method, '') not like '%-usdt-to-usd%'
on conflict (observed_at, asset) do nothing;

-- Collapse the repeated USDT Oracle observations once per source snapshot
-- before joining them to every archived asset. This keeps the repair bounded
-- by buckets plus archive rows instead of multiplying all asset/rate pairs.
with usdt_rate_buckets as materialized (
  select observed_at,
         sample_origin,
         thorchain_height,
         min(oracle_price_usd) as oracle_price_usd,
         min(oracle_observed_at) as oracle_observed_at
  from public.pool_dislocation_observations
  where oracle_symbol = 'USDT'
    and oracle_price_usd > 0
  group by observed_at, sample_origin, thorchain_height
  having count(distinct oracle_price_usd) = 1
     and count(distinct oracle_observed_at) = 1
     and count(*) = count(oracle_observed_at)
), same_bucket_rate_evidence as materialized (
  select observed_at,
         true as has_same_bucket_usdt_rate
  from public.pool_dislocation_observations
  where oracle_symbol = 'USDT'
    and oracle_price_usd > 0
  group by observed_at
), repairs as (
  select archive.observed_at,
         archive.asset,
         case
           when archive.binance_observed_at is not null
             and abs(extract(epoch from (
               rate.oracle_observed_at - archive.binance_observed_at
             ))) <= 30
             then rate.oracle_price_usd
           else null
         end as usdt_usd_rate,
         case
           when archive.binance_observed_at is not null
             and abs(extract(epoch from (
               rate.oracle_observed_at - archive.binance_observed_at
             ))) <= 30
             then rate.oracle_observed_at
           else null
         end as usdt_oracle_observed_at,
         coalesce(evidence.has_same_bucket_usdt_rate, false)
           as has_same_bucket_usdt_rate
  from public.pool_dislocation_binance_usdt_archive archive
  left join usdt_rate_buckets rate
    on rate.observed_at = archive.observed_at
   and rate.sample_origin = archive.sample_origin
   and rate.thorchain_height is not distinct from archive.thorchain_height
  left join same_bucket_rate_evidence evidence
    on evidence.observed_at = archive.observed_at
)
update public.pool_dislocation_binance_usdt_archive stored
set usdt_usd_rate = repair.usdt_usd_rate,
    usdt_oracle_observed_at = repair.usdt_oracle_observed_at,
    conversion_status = case
      when repair.usdt_usd_rate is not null then 'converted'
      when repair.has_same_bucket_usdt_rate then 'unaligned'
      else 'unavailable'
    end
from repairs repair
where stored.observed_at = repair.observed_at
  and stored.asset = repair.asset
  and (
    stored.usdt_usd_rate is distinct from repair.usdt_usd_rate
    or stored.usdt_oracle_observed_at is distinct from repair.usdt_oracle_observed_at
    or stored.conversion_status is distinct from case
      when repair.usdt_usd_rate is not null then 'converted'
      when repair.has_same_bucket_usdt_rate then 'unaligned'
      else 'unavailable'
    end
  );

with repairs as materialized (
  select archive.*,
         case
           when archive.source_price_method = 'kline-close' then 'kline-close'
           when archive.source_price_method = 'book-ticker-mid' then 'book-ticker-mid'
           when archive.binance_bid_usdt is null and archive.binance_ask_usdt is null
             then 'kline-close'
           else 'book-ticker-mid'
         end as source_method
  from public.pool_dislocation_binance_usdt_archive archive
), normalized as (
  select repair.observed_at,
         repair.asset,
         case
           when repair.usdt_usd_rate is null then null
           else repair.binance_bid_usdt * repair.usdt_usd_rate
         end as binance_bid_usd,
         case
           when repair.usdt_usd_rate is null then null
           else repair.binance_ask_usdt * repair.usdt_usd_rate
         end as binance_ask_usd,
         case
           when repair.usdt_usd_rate is null then null
           else repair.binance_price_usdt * repair.usdt_usd_rate
         end as binance_price_usd,
         case
           when repair.usdt_usd_rate is null
             and repair.conversion_status = 'unaligned'
             and repair.source_method = 'kline-close'
             then 'kline-close-usdt-to-usd-unaligned'
           when repair.usdt_usd_rate is null
             and repair.conversion_status = 'unaligned'
             then 'book-ticker-mid-usdt-to-usd-unaligned'
           when repair.usdt_usd_rate is null and repair.source_method = 'kline-close'
             then 'kline-close-usdt-to-usd-unavailable'
           when repair.usdt_usd_rate is null
             then 'book-ticker-mid-usdt-to-usd-unavailable'
           when repair.source_method = 'kline-close'
             then 'kline-close-usdt-to-usd'
           else 'book-ticker-mid-usdt-to-usd'
         end as binance_price_method,
         repair.binance_observed_at,
         case
           when repair.usdt_usd_rate is null then observation.source_skew_ms
           else greatest(
             observation.source_skew_ms,
             round(abs(extract(epoch from (
               repair.usdt_oracle_observed_at - repair.binance_observed_at
             ))) * 1000)::integer
           )
         end as source_skew_ms
  from repairs repair
  join public.pool_dislocation_observations observation
    on observation.observed_at = repair.observed_at
   and observation.asset = repair.asset
)
update public.pool_dislocation_observations observation
set binance_bid_usd = repair.binance_bid_usd,
    binance_ask_usd = repair.binance_ask_usd,
    binance_price_usd = repair.binance_price_usd,
    binance_price_method = repair.binance_price_method,
    binance_observed_at = repair.binance_observed_at,
    source_skew_ms = repair.source_skew_ms,
    updated_at = now()
from normalized repair
where observation.observed_at = repair.observed_at
  and observation.asset = repair.asset
  and (
    observation.binance_bid_usd is distinct from repair.binance_bid_usd
    or observation.binance_ask_usd is distinct from repair.binance_ask_usd
    or observation.binance_price_usd is distinct from repair.binance_price_usd
    or observation.binance_price_method is distinct from repair.binance_price_method
    or observation.binance_observed_at is distinct from repair.binance_observed_at
    or observation.source_skew_ms is distinct from repair.source_skew_ms
  );

-- The deploy path primes the pool-dislocation scheduler after migrations, so
-- remove the pre-correction materialization rather than serving stale values.
delete from public.api_read_models
where model_key = 'pool-dislocation-summary:v1';

commit;
