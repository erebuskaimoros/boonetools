-- Liquify Portal admission is spaced across ALL backend processes. Keep the
-- existing provider identity and counters: upgrading must not reset any quota.
alter table midgard_request_budgets add column if not exists next_request_at timestamptz;

create or replace function claim_midgard_request_budget_paced(
  budget_key text, is_bulk boolean, total_limits integer[], bulk_limits integer[],
  requested_at timestamptz, minimum_interval_ms integer
) returns table(allowed boolean, retry_at timestamptz, reason text, reserved_at timestamptz)
language plpgsql set lock_timeout = '2s' as $$
declare
  instant timestamptz := coalesce(requested_at, clock_timestamp());
  starts timestamptz[];
  spent bigint[];
  bulk_spent bigint[];
  state midgard_request_budgets%rowtype;
  quota_exhausted boolean := false;
  admission record;
  i integer;
begin
  if minimum_interval_ms is null or minimum_interval_ms < 1 or minimum_interval_ms > 60000 then
    raise exception 'Midgard pacing interval must be between 1 and 60000 milliseconds';
  end if;
  if array_length(total_limits, 1) is distinct from 3 or array_length(bulk_limits, 1) is distinct from 3 then
    raise exception 'Midgard budget requires minute, hour and day limits';
  end if;
  for i in 1..3 loop
    if total_limits[i] is null or bulk_limits[i] is null or total_limits[i] < 1
      or bulk_limits[i] < 1 or bulk_limits[i] > total_limits[i] then
      raise exception 'Invalid Midgard budget limits';
    end if;
  end loop;

  starts := array[
    date_trunc('minute', instant at time zone 'UTC') at time zone 'UTC',
    date_trunc('hour', instant at time zone 'UTC') at time zone 'UTC',
    date_trunc('day', instant at time zone 'UTC') at time zone 'UTC'];
  insert into midgard_request_budgets(provider_key, minute_start, hour_start, day_start, updated_at)
    values (budget_key, starts[1], starts[2], starts[3], instant) on conflict do nothing;
  select * into strict state from midgard_request_budgets where provider_key = budget_key for update;
  -- Sample the database clock AFTER acquiring the shared row lock. requested_at
  -- is solely a deterministic test clock; production passes NULL.
  instant := greatest(coalesce(requested_at, clock_timestamp()), state.updated_at);

  if state.next_request_at is not null and instant < state.next_request_at then
    starts := array[
      date_trunc('minute', instant at time zone 'UTC') at time zone 'UTC',
      date_trunc('hour', instant at time zone 'UTC') at time zone 'UTC',
      date_trunc('day', instant at time zone 'UTC') at time zone 'UTC'];
    spent := array[
      case when state.minute_start = starts[1] then state.minute_spent else 0 end,
      case when state.hour_start = starts[2] then state.hour_spent else 0 end,
      case when state.day_start = starts[3] then state.day_spent else 0 end];
    bulk_spent := array[
      case when state.minute_start = starts[1] then state.bulk_minute_spent else 0 end,
      case when state.hour_start = starts[2] then state.bulk_hour_spent else 0 end,
      case when state.day_start = starts[3] then state.bulk_day_spent else 0 end];
    for i in 1..3 loop
      quota_exhausted := quota_exhausted or spent[i] >= total_limits[i]
        or (is_bulk and bulk_spent[i] >= bulk_limits[i]);
    end loop;
    -- Real quota exhaustion takes precedence over a short pacing wait. Let the
    -- existing function choose its latest reset and record that deferral.
    if not quota_exhausted then
      allowed := false;
      retry_at := state.next_request_at;
      reason := 'pacing';
      reserved_at := null;
      return next;
      return;
    end if;
  end if;

  -- The existing function remains the sole owner of window accounting. Its
  -- row lock is already held by this transaction, so admission and the next
  -- shared slot advance atomically. Neither denial nor refund rewinds a slot.
  select * into strict admission from claim_midgard_request_budget(
    budget_key, is_bulk, total_limits, bulk_limits, instant);
  if admission.allowed then
    update midgard_request_budgets
      set next_request_at = admission.reserved_at + minimum_interval_ms * interval '1 millisecond'
      where provider_key = budget_key;
  end if;
  allowed := admission.allowed;
  retry_at := admission.retry_at;
  reason := admission.reason;
  reserved_at := admission.reserved_at;
  return next;
end;
$$;
