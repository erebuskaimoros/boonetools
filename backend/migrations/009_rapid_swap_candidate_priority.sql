begin;

create index if not exists rapid_swap_candidates_pending_recent_idx
  on public.rapid_swap_candidates (
    status,
    next_retry_at asc,
    observed_height desc,
    last_seen_at desc,
    first_seen_at desc
  );

commit;
