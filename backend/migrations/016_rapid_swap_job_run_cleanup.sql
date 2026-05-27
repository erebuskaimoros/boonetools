begin;

update public.rapid_swap_job_runs
set finished_at = coalesce(finished_at, started_at),
    status = 'error',
    error = coalesce(error, 'stale running scheduler row cleaned up by migration'),
    stats_json = coalesce(stats_json, '{}'::jsonb) || jsonb_build_object('cleanup_reason', 'stale_running_job')
where job_name = 'rapid-swaps-recent-actions'
  and status = 'running'
  and finished_at is null
  and started_at < now() - interval '2 hours';

commit;
