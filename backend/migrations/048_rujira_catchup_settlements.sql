begin;

-- Block 27545366 manually restored the halted revenue schedule and executed
-- the collector immediately. Its Reserve/POL settlement was emitted inside a
-- transaction result instead of the normal finalize-block scheduler lane.
-- Requeue the exact block so the transaction-aware parser records the missed
-- catch-up payment whether or not an older candidate row already exists.
insert into public.rujira_reserve_payment_blocks as existing
  (height, block_time, source, status, attempts, next_retry_at, error,
   scan_json, fetched_at, updated_at)
values (
  27545366,
  '2026-08-23T10:33:08.290494566Z',
  'post-halt-catchup-repair',
  'pending',
  0,
  now(),
  '',
  jsonb_build_object(
    'repair', 'transaction-result-settlement-parser',
    'reason', 'post-halt revenue schedule catch-up'
  ),
  null,
  now()
)
on conflict (height)
do update set
  block_time = coalesce(existing.block_time, excluded.block_time),
  source = excluded.source,
  status = 'pending',
  attempts = 0,
  next_retry_at = now(),
  error = '',
  scan_json = coalesce(existing.scan_json, '{}'::jsonb) || excluded.scan_json,
  fetched_at = null,
  updated_at = now();

-- Force the deployment prime to publish settlement and earnings models from
-- the repaired canonical event set instead of retaining a fresh stale model.
delete from public.api_read_models
where model_key in (
  'app-layer-reserve-payments:v1',
  'app-layer-base-layer-earnings:v1'
);

commit;
