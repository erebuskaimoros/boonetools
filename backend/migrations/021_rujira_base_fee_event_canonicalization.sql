begin;

alter table public.rujira_base_fee_events
  add column if not exists canonical_key text;

alter table public.rujira_base_fee_events
  add column if not exists source text not null default 'legacy';

alter table public.rujira_base_fee_events
  add column if not exists source_provenance jsonb not null default '{}'::jsonb;

update public.rujira_base_fee_events
set source = case
  when coalesce(raw_event->>'source', '') = 'dune'
    or coalesce(context_json->>'source', '') = 'dune'
    or context_origin = 'dune-wasm-tx'
    then 'dune'
  else 'legacy'
end;

update public.rujira_base_fee_events
set canonical_key = concat(
  'rujira-base-fee:v2|',
  height::text,
  '|',
  replace(replace(
    case
      when nullif(btrim(swap_id), '') is not null then upper(btrim(swap_id))
      else 'legacy:' || event_key
    end,
    '%', '%25'
  ), '|', '%7C'),
  '|',
  replace(replace(replace(upper(btrim(pool)), '~', '-'), '%', '%25'), '|', '%7C'),
  '|',
  replace(replace(lower(btrim(to_address)), '%', '%25'), '|', '%7C'),
  '|',
  replace(replace(btrim(memo), '%', '%25'), '|', '%7C'),
  '|',
  case
    when btrim(liquidity_fee_base) ~ '^[0-9]+$'
      then coalesce(nullif(ltrim(btrim(liquidity_fee_base), '0'), ''), '0')
    else '0'
  end
);

update public.rujira_base_fee_events
set source_provenance = jsonb_build_object(
  source,
  jsonb_strip_nulls(jsonb_build_object(
    'migrated', true,
    'context_origin', nullif(context_origin, ''),
    'query_id', coalesce(nullif(raw_event->>'query_id', ''), nullif(context_json->>'query_id', '')),
    'source_event_key', case
      when source = 'dune' then coalesce(
        nullif(raw_event->>'source_event_key', ''),
        nullif(raw_event->'row'->>'event_key', ''),
        event_key
      )
      else event_key
    end
  ))
)
where source_provenance = '{}'::jsonb;

with deleted as (
  delete from public.rujira_base_fee_events event
  where source = 'dune'
    and not (
      height > 0
      and block_time is not null
      -- Dune appends an event ordinal to otherwise valid THORChain swap IDs
      -- when a transaction emits more than one relevant row.
      and upper(btrim(swap_id)) ~ '^[A-F0-9]{64}(-[0-9]+)?$'
      and btrim(pool) <> ''
      and position('.' in btrim(pool)) > 0
      and upper(btrim(chain)) = 'THOR'
      and lower(btrim(from_address)) = 'thor1n5a08r0zvmqca39ka2tgwlkjy9ugalutk7fjpzptfppqcccnat2ska5t4g'
      and btrim(to_address) <> ''
      -- Direct RUJI Swap exclusions are retained only as audit rows. Dune does
      -- not populate a memo for that valid excluded shape, while every
      -- included row and other excluded classification still requires one.
      and (
        (
          classification = 'direct_ruji_swap_excluded'
          and not included
          and btrim(memo) = ''
        )
        or (
          btrim(memo) <> ''
          and left(btrim(memo), 11) <> '%%skipped%%'
        )
      )
      and btrim(coin) <> ''
      and btrim(liquidity_fee_base) ~ '^[0-9]+$'
      and liquidity_fee_rune >= 0
      and liquidity_fee_rune < 'Infinity'::double precision
      and rune_price_usd >= 0
      and rune_price_usd < 'Infinity'::double precision
      and liquidity_fee_usd >= 0
      and liquidity_fee_usd < 'Infinity'::double precision
      and abs(
        liquidity_fee_rune - (
          coalesce(nullif(ltrim(btrim(liquidity_fee_base), '0'), ''), '0')::numeric / 100000000.0
        )::double precision
      ) <= greatest(
        1e-10::double precision,
        greatest(
          abs(liquidity_fee_rune),
          abs((coalesce(nullif(ltrim(btrim(liquidity_fee_base), '0'), ''), '0')::numeric / 100000000.0)::double precision),
          1::double precision
        ) * 1e-6
      )
      and abs(
        liquidity_fee_usd - liquidity_fee_rune * rune_price_usd
      ) <= greatest(
        1e-10::double precision,
        greatest(
          abs(liquidity_fee_usd),
          abs(liquidity_fee_rune * rune_price_usd),
          1::double precision
        ) * 1e-6
      )
      and (
        (
          classification = 'base_collector_conversion'
          and included
          and lower(btrim(source_contract)) = 'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr'
        )
        or (
          classification in (
            'app_revenue_conversion',
            'fin_base_layer_execution',
            'ghost_base_layer_execution',
            'app_layer_contract_execution',
            'mixed_app_layer_context'
          )
          and included
          and lower(btrim(source_contract)) like 'thor1%'
          and lower(btrim(source_contract)) not in (
            'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr',
            'thor1mcy9jtp4kzl8q2lvdgfgsl8jvqrf504uphkf0pz2p9wud8tsntesjvccew',
            'thor1n5a08r0zvmqca39ka2tgwlkjy9ugalutk7fjpzptfppqcccnat2ska5t4g'
          )
        )
        or (
          classification = 'ruji_swap_revenue_excluded'
          and not included
          and lower(btrim(source_contract)) = 'thor1mcy9jtp4kzl8q2lvdgfgsl8jvqrf504uphkf0pz2p9wud8tsntesjvccew'
        )
        or (
          classification = 'direct_ruji_swap_excluded'
          and not included
          and lower(btrim(source_contract)) = 'thor1n5a08r0zvmqca39ka2tgwlkjy9ugalutk7fjpzptfppqcccnat2ska5t4g'
        )
        or (
          classification = 'mixed_or_excluded_context'
          and not included
          and (
            btrim(source_contract) = ''
            or lower(btrim(source_contract)) not in (
              'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr',
              'thor1mcy9jtp4kzl8q2lvdgfgsl8jvqrf504uphkf0pz2p9wud8tsntesjvccew',
              'thor1n5a08r0zvmqca39ka2tgwlkjy9ugalutk7fjpzptfppqcccnat2ska5t4g'
            )
          )
        )
      )
    )
  returning event.event_key
)
select count(*) as deleted_invalid_dune_rujira_base_fee_events
from deleted;

with provider_provenance as (
  select canonical_key,
         jsonb_object_agg(source, jsonb_build_object('migrated', true)) as providers
  from public.rujira_base_fee_events
  group by canonical_key
)
update public.rujira_base_fee_events event
set source_provenance = provider_provenance.providers || event.source_provenance
from provider_provenance
where event.canonical_key = provider_provenance.canonical_key;

with ranked as (
  select event_key,
         row_number() over (
           partition by canonical_key
           order by
             case when source = 'dune' then 0 else 1 end,
             updated_at desc,
             event_key desc
         ) as canonical_rank
  from public.rujira_base_fee_events
),
deleted as (
  delete from public.rujira_base_fee_events event
  using ranked
  where event.event_key = ranked.event_key
    and ranked.canonical_rank > 1
  returning event.event_key
)
select count(*) as deleted_duplicate_rujira_base_fee_events
from deleted;

update public.rujira_base_fee_events
set event_key = canonical_key;

alter table public.rujira_base_fee_events
  alter column canonical_key set not null;

create unique index if not exists rujira_base_fee_events_canonical_key_unique
  on public.rujira_base_fee_events (canonical_key);

create index if not exists rujira_base_fee_events_source_idx
  on public.rujira_base_fee_events (source, block_time desc);

commit;
