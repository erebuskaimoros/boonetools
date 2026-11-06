begin;

create table if not exists vote_key_references (
  vote_key text primary key,
  reference_json jsonb,
  evidence_hash text not null default '',
  source_version text not null default '',
  last_checked_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists vote_key_reference_revisions (
  id bigint generated always as identity primary key,
  vote_key text not null references vote_key_references(vote_key),
  evidence_hash text not null,
  source_version text not null,
  reference_json jsonb,
  evidence_json jsonb not null,
  model text not null default '',
  outcome text not null,
  usage_json jsonb,
  created_at timestamptz not null default now()
);
create index if not exists vote_key_reference_revision_key_idx on vote_key_reference_revisions(vote_key, id desc);
create table if not exists vote_key_reference_worker (
  singleton boolean primary key default true check(singleton),
  paused_until timestamptz,
  last_error text not null default '',
  usage_day date not null default current_date,
  calls_today integer not null default 0
);
insert into vote_key_reference_worker(singleton) values(true) on conflict do nothing;
commit;
