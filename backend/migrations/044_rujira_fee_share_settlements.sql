begin;

alter table public.rujira_reserve_payment_events
  add column if not exists payment_type text not null default 'reserve';

alter table public.rujira_reserve_payment_events
  drop constraint if exists rujira_reserve_payment_events_payment_type_check;

alter table public.rujira_reserve_payment_events
  add constraint rujira_reserve_payment_events_payment_type_check
  check (
    sender = 'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr'
    and (
      (
        payment_type = 'reserve'
        and recipient = 'thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt'
        and memo = 'RESERVE'
      )
      or (
        payment_type = 'pol'
        and recipient = 'thor1glpfjhxzjdtnz4wy3hv4ywl65y9w84l6efgen'
        and memo = 'POL'
        and height >= 27410412
      )
    )
  );

create index if not exists rujira_reserve_payment_events_type_time_idx
  on public.rujira_reserve_payment_events (payment_type, block_time desc);

-- These blocks were already scanned by deployments that only understood the
-- Reserve destination. Reparse them so their same-block POL transfers enter
-- the canonical settlement history.
update public.rujira_reserve_payment_blocks
set status = 'pending',
    attempts = 0,
    next_retry_at = now(),
    error = '',
    fetched_at = null,
    updated_at = now()
where height >= 27410412;

-- Resume the cadence scanner at the first payout under the new 2:1 config.
-- This also fills any post-cutover candidate rows absent from the block table.
insert into public.rujira_reserve_payment_sync_state
  (sync_key, next_page_token, next_scheduled_height, complete, updated_at, stats_json)
values (
  'rujira-reserve-payment-schedule:v1',
  '',
  27410412,
  false,
  now(),
  jsonb_build_object(
      'fee_share_reparse_height', 27410412,
      'fee_share_config_height', 27410382
  )
)
on conflict (sync_key)
do update set
  next_scheduled_height = excluded.next_scheduled_height,
  complete = excluded.complete,
  updated_at = excluded.updated_at,
  stats_json = coalesce(rujira_reserve_payment_sync_state.stats_json, '{}'::jsonb) || excluded.stats_json;

commit;
