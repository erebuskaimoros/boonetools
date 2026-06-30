begin;

with ranked as (
  select event_key,
         row_number() over (
           partition by height, tx_id, amount_base, sender, recipient, memo
           order by
             case when source = 'dune' then 0 else 1 end,
             block_time desc,
             updated_at desc,
             event_key desc
         ) as canonical_rank
  from public.rujira_reserve_payment_events
),
deleted as (
  delete from public.rujira_reserve_payment_events event
  using ranked
  where event.event_key = ranked.event_key
    and ranked.canonical_rank > 1
  returning event.event_key
)
select count(*) as deleted_duplicate_rujira_reserve_payment_events
from deleted;

commit;
