begin;

-- Dashboard summaries are published as read models, while event drill-downs
-- remain cursor-paginated against the canonical source tables. These indexes
-- keep those bounded detail reads on an ordered index path.
create index if not exists rujira_reserve_payment_events_cursor_idx
  on public.rujira_reserve_payment_events (block_time desc, height desc, event_key desc);

create index if not exists rujira_reserve_payment_events_last_seen_idx
  on public.rujira_reserve_payment_events (last_seen_at desc);

create index if not exists rujira_base_fee_events_cursor_idx
  on public.rujira_base_fee_events (block_time desc, height desc, event_key desc)
  where included = true;

create index if not exists rujira_base_fee_events_updated_idx
  on public.rujira_base_fee_events (updated_at desc);

create index if not exists rapid_swaps_date_tx_idx
  on public.rapid_swaps (action_date desc, tx_id asc);

create index if not exists rapid_swaps_last_seen_idx
  on public.rapid_swaps (last_seen_at desc);

create index if not exists node_votes_key_cursor_idx
  on public.node_votes (mimir_key, block_time desc nulls last, height desc, event_key desc);

create index if not exists node_votes_node_cursor_idx
  on public.node_votes (node_address, block_time desc nulls last, height desc, event_key desc);

create index if not exists node_votes_key_coalesced_cursor_idx
  on public.node_votes (
    mimir_key,
    (coalesce(block_time, 'epoch'::timestamptz)) desc,
    height desc,
    event_key desc
  );

create index if not exists node_votes_node_coalesced_cursor_idx
  on public.node_votes (
    node_address,
    (coalesce(block_time, 'epoch'::timestamptz)) desc,
    height desc,
    event_key desc
  );

create index if not exists node_votes_last_seen_idx
  on public.node_votes (last_seen_at desc);

create index if not exists tc_fee_dash_windows_updated_idx
  on public.tc_fee_dash_windows (updated_at desc);

commit;
