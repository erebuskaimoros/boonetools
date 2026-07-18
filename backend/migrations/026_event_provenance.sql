begin;

create table if not exists public.event_source_observations (
  domain text not null,
  canonical_key text not null,
  source text not null,
  source_event_key text not null default '',
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  raw_reference jsonb not null default '{}'::jsonb,
  schema_version integer not null default 1,
  primary key (domain, canonical_key, source, source_event_key)
);

create index if not exists event_source_observations_canonical_idx
  on public.event_source_observations (domain, canonical_key, last_observed_at desc);

alter table public.rapid_swaps
  add column if not exists canonical_key text,
  add column if not exists preferred_source text not null default 'unknown',
  add column if not exists first_seen_at timestamptz not null default now(),
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists schema_version integer not null default 1;

update public.rapid_swaps
set canonical_key = upper(trim(tx_id)),
    preferred_source = coalesce(
      nullif(lower(raw_action ->> 'source'), ''),
      nullif(lower(preferred_source), 'unknown'),
      'midgard'
    ),
    first_seen_at = least(first_seen_at, observed_at),
    last_seen_at = greatest(last_seen_at, observed_at)
where canonical_key is null or canonical_key = '';

alter table public.rapid_swaps
  alter column canonical_key set not null;

insert into public.event_source_observations (
  domain,
  canonical_key,
  source,
  source_event_key,
  first_observed_at,
  last_observed_at,
  raw_reference,
  schema_version
)
select 'rapid-swaps', canonical_key, preferred_source, tx_id, first_seen_at, last_seen_at,
       jsonb_build_object('tx_id', tx_id), schema_version
from public.rapid_swaps
on conflict do nothing;

with ranked as (
  select ctid,
         row_number() over (
           partition by canonical_key
           order by
             case lower(preferred_source)
               when 'dune' then 100 when 'thornode' then 90
               when 'rpc' then 80 when 'ws' then 80 when 'midgard' then 70
               when 'backfill' then 50 when 'scheduled' then 40 else 0
             end desc,
             last_seen_at desc,
             tx_id desc
         ) as duplicate_rank
  from public.rapid_swaps
)
delete from public.rapid_swaps event
using ranked
where event.ctid = ranked.ctid
  and ranked.duplicate_rank > 1;

drop index if exists public.rapid_swaps_canonical_key_idx;
create unique index if not exists rapid_swaps_canonical_key_unique
  on public.rapid_swaps (canonical_key);

alter table public.node_votes
  add column if not exists canonical_key text,
  add column if not exists preferred_source text not null default 'unknown',
  add column if not exists first_seen_at timestamptz not null default now(),
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists schema_version integer not null default 1;

update public.node_votes
set canonical_key = case
      when nullif(trim(tx_id), '') is not null then concat_ws(
        ':',
        'node-vote',
        upper(trim(tx_id)),
        event_index::text
      )
      else concat_ws(
        ':',
        'node-vote',
        height::text,
        event_index::text,
        lower(trim(node_address)),
        upper(trim(mimir_key)),
        trim(vote_value)
      )
    end,
    preferred_source = coalesce(nullif(source, ''), 'unknown'),
    first_seen_at = least(first_seen_at, observed_at, created_at),
    last_seen_at = greatest(last_seen_at, observed_at, updated_at)
where canonical_key is null or canonical_key = '';

alter table public.node_votes
  alter column canonical_key set not null;

-- Preserve every provider observation before canonical rows are collapsed.
insert into public.event_source_observations (
  domain,
  canonical_key,
  source,
  source_event_key,
  first_observed_at,
  last_observed_at,
  raw_reference,
  schema_version
)
select 'node-votes', canonical_key, preferred_source, event_key, first_seen_at, last_seen_at,
       jsonb_build_object('event_key', event_key, 'tx_id', tx_id), schema_version
from public.node_votes
on conflict do nothing;

with ranked as (
  select ctid,
         row_number() over (
           partition by canonical_key
           order by
             case lower(preferred_source)
               when 'dune' then 100 when 'thornode' then 90
               when 'rpc' then 80 when 'ws' then 80 when 'midgard' then 70
               when 'backfill' then 50 when 'scheduled' then 40 else 0
             end desc,
             last_seen_at desc,
             event_key desc
         ) as duplicate_rank
  from public.node_votes
)
delete from public.node_votes event
using ranked
where event.ctid = ranked.ctid
  and ranked.duplicate_rank > 1;

drop index if exists public.node_votes_canonical_key_idx;
create unique index if not exists node_votes_canonical_key_unique
  on public.node_votes (canonical_key);

alter table public.node_votes
  drop constraint if exists node_votes_pkey;
drop index if exists public.node_votes_tx_event_idx;
alter table public.node_votes
  add constraint node_votes_pkey primary key using index node_votes_canonical_key_unique;

alter table public.rujira_reserve_payment_events
  add column if not exists canonical_key text,
  add column if not exists preferred_source text not null default 'unknown',
  add column if not exists first_seen_at timestamptz not null default now(),
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists schema_version integer not null default 1;

update public.rujira_reserve_payment_events
set canonical_key = concat_ws(
      ':',
      'reserve-payment',
      height::text,
      upper(trim(tx_id)),
      amount_base::text,
      lower(trim(sender)),
      lower(trim(recipient)),
      upper(trim(memo))
    ),
    preferred_source = coalesce(nullif(source, ''), 'unknown'),
    first_seen_at = least(first_seen_at, created_at),
    last_seen_at = greatest(last_seen_at, updated_at)
where canonical_key is null or canonical_key = '';

alter table public.rujira_reserve_payment_events
  alter column canonical_key set not null;

-- Preserve every provider observation before canonical rows are collapsed.
insert into public.event_source_observations (
  domain,
  canonical_key,
  source,
  source_event_key,
  first_observed_at,
  last_observed_at,
  raw_reference,
  schema_version
)
select 'rujira-reserve-payments', canonical_key, preferred_source, event_key, first_seen_at, last_seen_at,
       jsonb_build_object('event_key', event_key, 'tx_id', tx_id), schema_version
from public.rujira_reserve_payment_events
on conflict do nothing;

with ranked as (
  select ctid,
         row_number() over (
           partition by canonical_key
           order by
             case lower(preferred_source)
               when 'dune' then 100 when 'thornode' then 90
               when 'rpc' then 80 when 'ws' then 80 when 'midgard' then 70
               when 'backfill' then 50 when 'scheduled' then 40 else 0
             end desc,
             last_seen_at desc,
             event_key desc
         ) as duplicate_rank
  from public.rujira_reserve_payment_events
)
delete from public.rujira_reserve_payment_events event
using ranked
where event.ctid = ranked.ctid
  and ranked.duplicate_rank > 1;

drop index if exists public.rujira_reserve_payment_events_canonical_key_idx;
create unique index if not exists rujira_reserve_payment_events_canonical_key_unique
  on public.rujira_reserve_payment_events (canonical_key);

alter table public.rujira_reserve_payment_events
  drop constraint if exists rujira_reserve_payment_events_pkey;
alter table public.rujira_reserve_payment_events
  add constraint rujira_reserve_payment_events_pkey
  primary key using index rujira_reserve_payment_events_canonical_key_unique;

insert into public.event_source_observations (
  domain,
  canonical_key,
  source,
  source_event_key,
  first_observed_at,
  last_observed_at,
  raw_reference,
  schema_version
)
select 'rapid-swaps', canonical_key, preferred_source, tx_id, first_seen_at, last_seen_at,
       jsonb_build_object('tx_id', tx_id), schema_version
from public.rapid_swaps
on conflict do nothing;

insert into public.event_source_observations (
  domain,
  canonical_key,
  source,
  source_event_key,
  first_observed_at,
  last_observed_at,
  raw_reference,
  schema_version
)
select 'node-votes', canonical_key, preferred_source, event_key, first_seen_at, last_seen_at,
       jsonb_build_object('event_key', event_key, 'tx_id', tx_id), schema_version
from public.node_votes
on conflict do nothing;

insert into public.event_source_observations (
  domain,
  canonical_key,
  source,
  source_event_key,
  first_observed_at,
  last_observed_at,
  raw_reference,
  schema_version
)
select 'rujira-reserve-payments', canonical_key, preferred_source, event_key, first_seen_at, last_seen_at,
       jsonb_build_object('event_key', event_key, 'tx_id', tx_id), schema_version
from public.rujira_reserve_payment_events
on conflict do nothing;

commit;
