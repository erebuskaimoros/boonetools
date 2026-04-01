import { insertRows, upsertRows } from '../db/sql.js';
import { withAdvisoryLock } from '../db/lock.js';
import { safeNumber, toIsoString } from '../lib/utils.js';
import {
  buildChainSyncRows,
  computeMajorityVersion,
  extractThorHeight,
  fetchChurns,
  fetchHistoricalNodesAtHeight,
  fetchLastblock,
  fetchNodes
} from '../shared/thornode.js';
import {
  computeLeaderboardRows,
  normalizeBoundarySnapshot
} from '../shared/leaderboard.js';

function toSampleHourIso(now = new Date()) {
  const date = new Date(now);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function parseMidgardTimestampToIso(value) {
  const nowIso = new Date().toISOString();
  const numeric = Number(value);

  if (Number.isFinite(numeric) && numeric > 0) {
    let millis = 0;
    if (numeric > 1e15) {
      millis = Math.trunc(numeric / 1e6);
    } else if (numeric > 1e12) {
      millis = Math.trunc(numeric);
    } else {
      millis = Math.trunc(numeric * 1000);
    }

    const fromNumeric = new Date(millis);
    if (Number.isFinite(fromNumeric.getTime())) {
      return fromNumeric.toISOString();
    }
  }

  const fromString = new Date(String(value || ''));
  if (Number.isFinite(fromString.getTime())) {
    return fromString.toISOString();
  }

  return nowIso;
}

function parseChurnRows(churns) {
  if (!Array.isArray(churns)) {
    return [];
  }

  return churns
    .slice(0, 11)
    .map((churn) => ({
      height: Number(churn?.height) || 0,
      churn_time: parseMidgardTimestampToIso(churn?.date)
    }))
    .filter((row) => Number.isFinite(row.height) && row.height > 0);
}

async function insertJobRun(client, payload) {
  const { rows } = await client.query(
    `insert into nodeop_job_runs
      (job_name, started_at, status, error, stats_json)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      payload.job_name,
      payload.started_at || new Date().toISOString(),
      payload.status,
      payload.error || null,
      payload.stats_json || {}
    ]
  );

  return String(rows[0].id);
}

async function completeJobRun(client, jobId, payload) {
  if (!jobId) {
    return;
  }

  await client.query(
    `update nodeop_job_runs
     set finished_at = $2,
         status = $3,
         error = $4,
         stats_json = $5
     where id = $1`,
    [
      jobId,
      payload.finished_at || new Date().toISOString(),
      payload.status,
      payload.error || null,
      payload.stats_json || {}
    ]
  );
}

async function replaceBoundarySnapshot(client, height, snapshot) {
  await client.query('delete from nodeop_boundary_snapshots where height = $1', [height]);
  if (!snapshot.length) {
    return;
  }

  const rows = snapshot.map((row) => ({
    height,
    node_address: row.node_address,
    slash_points: row.slash_points,
    status: row.status
  }));

  await insertRows(client, 'nodeop_boundary_snapshots', rows);
}

async function getStoredBoundarySnapshot(client, height) {
  const { rows } = await client.query(
    `select node_address, slash_points, status
     from nodeop_boundary_snapshots
     where height = $1`,
    [height]
  );

  return normalizeBoundarySnapshot(rows || []);
}

export async function runNodeopScheduler() {
  return withAdvisoryLock('boonetools:nodeop-scheduler', async (client) => {
    let jobId = '';

    try {
      const startedAt = new Date().toISOString();
      jobId = await insertJobRun(client, {
        job_name: 'nodeop-hourly',
        started_at: startedAt,
        status: 'running',
        stats_json: {}
      });

      const [existingChurnResult, existingLeaderboardResult] = await Promise.all([
        client.query(
          `select height
           from nodeop_churn_events
           order by height desc
           limit 1`
        ),
        client.query(
          `select as_of
           from nodeop_leaderboard_latest
           order by as_of desc
           limit 1`
        )
      ]);

      const previousTopChurn = Number(existingChurnResult.rows[0]?.height) || 0;
      const previousLeaderboardAsOf = existingLeaderboardResult.rows[0]?.as_of || null;

      const [nodes, lastblockRows, churns] = await Promise.all([
        fetchNodes(),
        fetchLastblock(),
        fetchChurns()
      ]);

      const now = new Date();
      const asOf = now.toISOString();
      const sampleHour = toSampleHourIso(now);
      const sourceHeight = extractThorHeight(lastblockRows);
      const majorityVersion = computeMajorityVersion(nodes);

      const performanceRows = (nodes || [])
        .filter((node) => Boolean(node?.node_address))
        .map((node) => {
          const slashPoints = Number(node?.slash_points) || 0;
          const missingBlocks = Number(node?.missing_blocks) || 0;
          const currentAwardBase = Number(node?.current_award) || 0;
          const jailReleaseHeight = Number(node?.jail?.release_height) || 0;
          const jailReason = String(node?.jail?.reason || node?.preflight_status?.reason || '');
          const jailJailed = jailReleaseHeight > sourceHeight;

          return {
            sample_hour: sampleHour,
            node_address: String(node.node_address),
            slash_points: slashPoints,
            missing_blocks: missingBlocks,
            current_award_base: currentAwardBase,
            status: String(node?.status || ''),
            jail_jailed: jailJailed,
            jail_release_height: jailReleaseHeight,
            jail_blocks_remaining: jailJailed ? Math.max(0, jailReleaseHeight - sourceHeight) : 0,
            jail_reason: jailReason,
            preflight_status: String(node?.preflight_status?.status || ''),
            preflight_reason: String(node?.preflight_status?.reason || ''),
            preflight_code: Number(node?.preflight_status?.code) || 0,
            node_version: String(node?.version || ''),
            majority_version: majorityVersion,
            version_compliant: majorityVersion ? String(node?.version || '') === majorityVersion : null,
            source_height: sourceHeight,
            chain_sync_json: buildChainSyncRows(node, nodes),
            as_of: asOf
          };
        });

      await upsertRows(client, 'nodeop_performance_samples', performanceRows, {
        conflictColumns: ['sample_hour', 'node_address'],
        jsonColumns: ['chain_sync_json']
      });

      const churnRows = parseChurnRows(churns);
      const churnHeights = churnRows.map((row) => row.height);
      const latestChurnHeight = churnHeights[0] || 0;

      if (churnRows.length > 0) {
        await upsertRows(client, 'nodeop_churn_events', churnRows, {
          conflictColumns: ['height'],
          updateColumns: ['churn_time']
        });
      }

      const churnChanged = latestChurnHeight > 0 && latestChurnHeight !== previousTopChurn;
      const leaderboardStale = !previousLeaderboardAsOf
        || (Date.now() - Date.parse(toIsoString(previousLeaderboardAsOf))) > 60 * 60 * 1000;
      const shouldRecomputeLeaderboard = churnChanged || leaderboardStale;

      let requestedWindows = Math.min(10, Math.max(0, churnHeights.length - 1));
      let computedWindows = 0;
      let leaderboardRowCount = 0;
      let historicalFetchFailures = 0;
      let historicalCacheHits = 0;
      let preBoundaryFetchFailures = 0;

      if (shouldRecomputeLeaderboard && churnHeights.length >= 2) {
        const postChurnSnapshotsByHeight = {};

        for (const height of churnHeights) {
          try {
            const historicalNodes = await fetchHistoricalNodesAtHeight(height);
            const snapshot = normalizeBoundarySnapshot(historicalNodes);
            await replaceBoundarySnapshot(client, height, snapshot);
            postChurnSnapshotsByHeight[height] = snapshot;
          } catch {
            historicalFetchFailures += 1;

            const snapshot = await getStoredBoundarySnapshot(client, height);
            if (snapshot.length > 0) {
              historicalCacheHits += 1;
              postChurnSnapshotsByHeight[height] = snapshot;
            }
          }
        }

        const endSnapshotsByHeight = {};
        const endBoundaryHeights = churnHeights.slice(0, requestedWindows);
        for (const endHeight of endBoundaryHeights) {
          const preChurnHeight = Number(endHeight) - 1;
          if (!Number.isFinite(preChurnHeight) || preChurnHeight <= 0) {
            if (postChurnSnapshotsByHeight[endHeight]) {
              endSnapshotsByHeight[endHeight] = postChurnSnapshotsByHeight[endHeight];
            }
            continue;
          }

          try {
            const preChurnNodes = await fetchHistoricalNodesAtHeight(preChurnHeight);
            endSnapshotsByHeight[endHeight] = normalizeBoundarySnapshot(preChurnNodes);
          } catch {
            preBoundaryFetchFailures += 1;
            if (postChurnSnapshotsByHeight[endHeight]) {
              endSnapshotsByHeight[endHeight] = postChurnSnapshotsByHeight[endHeight];
            }
          }
        }

        const computed = computeLeaderboardRows({
          churnHeights,
          snapshotsByHeight: postChurnSnapshotsByHeight,
          endSnapshotsByHeight,
          minParticipation: 3,
          maxWindows: 10
        });

        requestedWindows = computed.requestedWindows;
        computedWindows = computed.computedWindows;
        leaderboardRowCount = computed.rows.length;

        await client.query('delete from nodeop_leaderboard_latest where node_address <> $1', ['']);

        if (computed.rows.length > 0) {
          const leaderboardRows = computed.rows.map((row) => ({
            node_address: row.node_address,
            as_of: asOf,
            requested_windows: computed.requestedWindows,
            computed_windows: computed.computedWindows,
            per_window: row.perWindow,
            total: row.total,
            avg_per_churn: row.avgPerChurn,
            participation: row.participation,
            rank: row.rank
          }));

          await insertRows(client, 'nodeop_leaderboard_latest', leaderboardRows);
        }
      }

      await client.query('select public.nodeop_prune_old_data($1, $2)', [30, 11]);

      const stats = {
        nodes_seen: performanceRows.length,
        source_height: sourceHeight,
        latest_churn_height: latestChurnHeight,
        churn_changed: churnChanged,
        leaderboard_stale: leaderboardStale,
        leaderboard_recomputed: shouldRecomputeLeaderboard,
        requested_windows: requestedWindows,
        computed_windows: computedWindows,
        leaderboard_rows: leaderboardRowCount,
        historical_fetch_failures: historicalFetchFailures,
        historical_cache_hits: historicalCacheHits,
        pre_boundary_fetch_failures: preBoundaryFetchFailures
      };

      await completeJobRun(client, jobId, {
        finished_at: new Date().toISOString(),
        status: 'success',
        error: null,
        stats_json: stats
      });

      return {
        ok: true,
        stats
      };
    } catch (error) {
      if (jobId) {
        await completeJobRun(client, jobId, {
          finished_at: new Date().toISOString(),
          status: 'error',
          error: error.message || 'Node Operator scheduler failed',
          stats_json: {}
        }).catch(() => {});
      }

      throw error;
    }
  });
}
