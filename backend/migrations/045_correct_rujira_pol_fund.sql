begin;

alter table public.rujira_reserve_payment_events
  drop constraint if exists rujira_reserve_payment_events_payment_type_check;

-- Migration 044 used an incomplete POL-fund address. Remove any observations
-- and canonical rows produced for that impossible route instead of rewriting
-- them as real on-chain transfers.
delete from public.event_source_observations observation
using public.rujira_reserve_payment_events event
where observation.domain = 'rujira-reserve-payments'
  and observation.canonical_key = event.canonical_key
  and event.payment_type = 'pol'
  and event.recipient = 'thor1glpfjhxzjdtnz4wy3hv4ywl65y9w84l6efgen';

delete from public.rujira_reserve_payment_events
where payment_type = 'pol'
  and recipient = 'thor1glpfjhxzjdtnz4wy3hv4ywl65y9w84l6efgen';

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
        and recipient = 'thor1glpf75rxtuu0mahvf0cqg27ek22x9w0uc5rkpcf9g0d9499pqcdql3fgen'
        and memo = 'POL'
        and height >= 27410412
      )
    )
  );

-- Reparse every known cadence block at or after the first payout under the
-- new split. Existing Reserve rows retain their canonical identity, while the
-- corrected parser discovers the missing same-block POL transfers.
update public.rujira_reserve_payment_blocks
set status = 'pending',
    attempts = 0,
    next_retry_at = now(),
    error = '',
    scan_json = '{}'::jsonb,
    fetched_at = null,
    updated_at = now()
where height >= 27410412;

-- Rewind, but never advance, an older recovery cursor. This also recreates the
-- schedule state if it is absent and clears a stale completion/rate-limit flag.
insert into public.rujira_reserve_payment_sync_state
  (sync_key, next_page_token, next_scheduled_height, complete, rate_limited_until, updated_at, stats_json)
values (
  'rujira-reserve-payment-schedule:v1',
  '',
  27410412,
  false,
  null,
  now(),
  jsonb_build_object(
    'fee_share_reparse_height', 27410412,
    'fee_share_config_height', 27410382,
    'pol_target_corrected', true
  )
)
on conflict (sync_key)
do update set
  next_scheduled_height = case
    when rujira_reserve_payment_sync_state.next_scheduled_height <= 0
      then excluded.next_scheduled_height
    else least(rujira_reserve_payment_sync_state.next_scheduled_height, excluded.next_scheduled_height)
  end,
  complete = false,
  rate_limited_until = null,
  updated_at = excluded.updated_at,
  stats_json = coalesce(rujira_reserve_payment_sync_state.stats_json, '{}'::jsonb) || excluded.stats_json;

commit;
