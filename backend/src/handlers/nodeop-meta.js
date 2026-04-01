import { query } from '../db/pool.js';
import { json } from '../lib/http.js';
import { toIsoString } from '../lib/utils.js';

export async function handleNodeopMeta() {
  const [hourlyRunResult, churnResult, leaderboardResult] = await Promise.all([
    query(
      `select finished_at
       from nodeop_job_runs
       where job_name = $1 and status = $2
       order by finished_at desc
       limit 1`,
      ['nodeop-hourly', 'success']
    ),
    query(
      `select height
       from nodeop_churn_events
       order by height desc
       limit 1`
    ),
    query(
      `select as_of
       from nodeop_leaderboard_latest
       order by as_of desc
       limit 1`
    )
  ]);

  const lastHourlyRunAt = hourlyRunResult.rows[0]?.finished_at || null;
  const lastChurnHeight = Number(churnResult.rows[0]?.height) || 0;
  const lastLeaderboardComputeAt = leaderboardResult.rows[0]?.as_of || null;
  const freshnessSeconds = lastHourlyRunAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(toIsoString(lastHourlyRunAt))) / 1000))
    : -1;

  const status = freshnessSeconds >= 0 && freshnessSeconds <= 5400
    ? 'healthy'
    : 'stale';

  return json(
    {
      last_hourly_run_at: toIsoString(lastHourlyRunAt),
      last_churn_height: lastChurnHeight,
      last_leaderboard_compute_at: toIsoString(lastLeaderboardComputeAt),
      data_freshness_seconds: freshnessSeconds,
      status
    },
    200,
    {
      'Cache-Control': 'public, max-age=30'
    }
  );
}
