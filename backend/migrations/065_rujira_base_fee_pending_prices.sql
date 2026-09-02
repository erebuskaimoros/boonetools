begin;

-- The pricing job first seeks included unpriced rows, then prices both included
-- and excluded rows only inside those UTC weeks. Keep completed history out of
-- this index so an idle refresh does not traverse the large event heap.
create index if not exists rujira_base_fee_events_unpriced_idx
  on public.rujira_base_fee_events (included, block_time)
  where block_time is not null and source <> 'dune' and rune_price_usd = 0;

commit;
