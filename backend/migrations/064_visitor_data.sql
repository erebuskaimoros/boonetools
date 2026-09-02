begin;

create table if not exists public.dynamic_fee_affiliate_actions (
  affiliate text not null,
  action_key text not null,
  action_time bigint not null,
  height bigint not null,
  leg_volume_usd numeric not null default 0,
  raw_action jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (affiliate, action_key)
);
create index if not exists dynamic_fee_affiliate_actions_time_idx
  on public.dynamic_fee_affiliate_actions (affiliate, action_time);

create table if not exists public.dynamic_fee_affiliate_days (
  affiliate text not null,
  day date not null,
  point_json jsonb not null,
  completed_at timestamptz,
  observed_at timestamptz not null default now(),
  primary key (affiliate, day)
);

create table if not exists public.dynamic_fee_affiliate_sync (
  affiliate text primary key,
  requested_from bigint not null,
  requested_to bigint not null,
  requested_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  scan_from bigint,
  scan_to bigint,
  scan_watermark bigint,
  source_base text,
  page_token text not null default '',
  seen_tokens_json jsonb not null default '[]',
  last_error text,
  updated_at timestamptz not null default now()
);

create table if not exists public.visitor_snapshot_requests (
  snapshot_key text primary key,
  kind text not null,
  params_json jsonb not null default '{}',
  requested_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  pending boolean not null default true,
  last_error text
);

commit;
