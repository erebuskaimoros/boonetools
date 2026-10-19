-- Durable shared safety budgets, not upstream-provider advertised quotas.
-- UTC fixed windows bound all backend processes; bulk scans leave live capacity.
create table if not exists midgard_request_budgets (
  provider_key text primary key,
  minute_start timestamptz not null,
  hour_start timestamptz not null,
  day_start timestamptz not null,
  minute_spent bigint not null default 0 check (minute_spent >= 0),
  hour_spent bigint not null default 0 check (hour_spent >= 0),
  day_spent bigint not null default 0 check (day_spent >= 0),
  bulk_minute_spent bigint not null default 0 check (bulk_minute_spent >= 0),
  bulk_hour_spent bigint not null default 0 check (bulk_hour_spent >= 0),
  bulk_day_spent bigint not null default 0 check (bulk_day_spent >= 0),
  spent_total bigint not null default 0,
  bulk_spent_total bigint not null default 0,
  deferred_total bigint not null default 0,
  bulk_deferred_total bigint not null default 0,
  last_deferred_reason text,
  last_deferred_at timestamptz,
  updated_at timestamptz not null default now()
);

create or replace function claim_midgard_request_budget(
  budget_key text, is_bulk boolean, total_limits integer[], bulk_limits integer[],
  requested_at timestamptz default null
) returns table(allowed boolean, retry_at timestamptz, reason text, reserved_at timestamptz)
language plpgsql set lock_timeout = '2s' as $$
declare
  instant timestamptz := coalesce(requested_at, clock_timestamp());
  starts timestamptz[];
  stops timestamptz[];
  names text[] := array['minute', 'hour', 'day'];
  spent bigint[];
  bulk_spent bigint[];
  state midgard_request_budgets%rowtype;
  blocked_until timestamptz;
  blocked_reason text;
  i integer;
begin
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
  -- Admission time is sampled AFTER row-lock acquisition. A queued request or
  -- backwards clock adjustment must not reset counters to an older window.
  instant := greatest(coalesce(requested_at, clock_timestamp()), state.updated_at);
  starts := array[
    date_trunc('minute', instant at time zone 'UTC') at time zone 'UTC',
    date_trunc('hour', instant at time zone 'UTC') at time zone 'UTC',
    date_trunc('day', instant at time zone 'UTC') at time zone 'UTC'];
  stops := array[starts[1] + interval '1 minute', starts[2] + interval '1 hour', starts[3] + interval '24 hours'];
  spent := array[
    case when state.minute_start = starts[1] then state.minute_spent else 0 end,
    case when state.hour_start = starts[2] then state.hour_spent else 0 end,
    case when state.day_start = starts[3] then state.day_spent else 0 end];
  bulk_spent := array[
    case when state.minute_start = starts[1] then state.bulk_minute_spent else 0 end,
    case when state.hour_start = starts[2] then state.bulk_hour_spent else 0 end,
    case when state.day_start = starts[3] then state.bulk_day_spent else 0 end];
  for i in 1..3 loop
    if spent[i] >= total_limits[i] and (blocked_until is null or stops[i] > blocked_until) then
      blocked_until := stops[i]; blocked_reason := 'total-' || names[i];
    end if;
    if is_bulk and bulk_spent[i] >= bulk_limits[i] and (blocked_until is null or stops[i] > blocked_until) then
      blocked_until := stops[i]; blocked_reason := 'bulk-' || names[i];
    end if;
  end loop;
  allowed := blocked_until is null;
  update midgard_request_budgets set
    minute_start = starts[1], hour_start = starts[2], day_start = starts[3],
    minute_spent = spent[1] + allowed::integer,
    hour_spent = spent[2] + allowed::integer,
    day_spent = spent[3] + allowed::integer,
    bulk_minute_spent = bulk_spent[1] + (allowed and is_bulk)::integer,
    bulk_hour_spent = bulk_spent[2] + (allowed and is_bulk)::integer,
    bulk_day_spent = bulk_spent[3] + (allowed and is_bulk)::integer,
    spent_total = spent_total + allowed::integer,
    bulk_spent_total = bulk_spent_total + (allowed and is_bulk)::integer,
    deferred_total = deferred_total + (not allowed)::integer,
    bulk_deferred_total = bulk_deferred_total + (not allowed and is_bulk)::integer,
    last_deferred_reason = case when allowed then last_deferred_reason else blocked_reason end,
    last_deferred_at = case when allowed then last_deferred_at else instant end,
    updated_at = instant
    where provider_key = budget_key;
  retry_at := blocked_until;
  reason := blocked_reason;
  reserved_at := case when allowed then instant else null end;
  return next;
end;
$$;

-- Only used when caller cancellation wins between admission and actual fetch.
-- Matching windows prevent a late refund from reducing a newer window's usage.
create or replace function refund_midgard_request_budget(
  budget_key text, is_bulk boolean, reserved_at timestamptz
) returns void language sql set lock_timeout = '2s' as $$
  update midgard_request_budgets set
    minute_spent = greatest(0, minute_spent - (minute_start = date_trunc('minute', reserved_at at time zone 'UTC') at time zone 'UTC')::integer),
    hour_spent = greatest(0, hour_spent - (hour_start = date_trunc('hour', reserved_at at time zone 'UTC') at time zone 'UTC')::integer),
    day_spent = greatest(0, day_spent - (day_start = date_trunc('day', reserved_at at time zone 'UTC') at time zone 'UTC')::integer),
    bulk_minute_spent = greatest(0, bulk_minute_spent - (is_bulk and minute_start = date_trunc('minute', reserved_at at time zone 'UTC') at time zone 'UTC')::integer),
    bulk_hour_spent = greatest(0, bulk_hour_spent - (is_bulk and hour_start = date_trunc('hour', reserved_at at time zone 'UTC') at time zone 'UTC')::integer),
    bulk_day_spent = greatest(0, bulk_day_spent - (is_bulk and day_start = date_trunc('day', reserved_at at time zone 'UTC') at time zone 'UTC')::integer),
    spent_total = greatest(0, spent_total - 1),
    bulk_spent_total = greatest(0, bulk_spent_total - is_bulk::integer),
    updated_at = greatest(updated_at, clock_timestamp())
    where provider_key = budget_key;
$$;
