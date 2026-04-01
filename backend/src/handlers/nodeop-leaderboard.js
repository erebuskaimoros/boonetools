import { query } from '../db/pool.js';
import { error, json, parseIntegerParam } from '../lib/http.js';
import { toIsoString } from '../lib/utils.js';
import { fetchNodes } from '../shared/thornode.js';

function normalizePerWindow(row, windows) {
  const input = Array.isArray(row.per_window) ? row.per_window : [];
  const output = Array(windows).fill(null);

  for (let index = 0; index < windows; index += 1) {
    const value = input[index];
    if (value == null) {
      output[index] = null;
      continue;
    }

    const parsed = Number(value);
    output[index] = Number.isFinite(parsed) ? parsed : null;
  }

  return output;
}

function buildBoundarySlashMap(rows) {
  const map = new Map();

  for (const row of rows || []) {
    const address = String(row?.node_address || '');
    if (!address) {
      continue;
    }
    map.set(address, Number(row?.slash_points) || 0);
  }

  return map;
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function buildCurrentDeltaByNode(currentNodes, boundaryRows) {
  const boundarySlashMap = buildBoundarySlashMap(boundaryRows);
  const deltaMap = new Map();

  for (const node of currentNodes || []) {
    const address = String(node?.node_address || '');
    if (!address) {
      continue;
    }

    const currentSlash = Number(node?.slash_points) || 0;
    const boundarySlash = boundarySlashMap.get(address) ?? 0;
    const delta = Math.max(0, currentSlash - boundarySlash);
    deltaMap.set(address, delta);
  }

  return deltaMap;
}

function buildCurrentNodeOperatorMap(currentNodes) {
  const map = new Map();

  for (const node of currentNodes || []) {
    const address = String(node?.node_address || '');
    if (!address) {
      continue;
    }
    map.set(address, String(node?.node_operator_address || ''));
  }

  return map;
}

function buildActiveNodeSet(rows) {
  const active = new Set();

  for (const row of rows || []) {
    const address = String(row?.node_address || '');
    if (!address) {
      continue;
    }
    if (normalizeStatus(row?.status) === 'active') {
      active.add(address);
    }
  }

  return active;
}

function toSortedAddresses(values) {
  return Array.from(values).sort((left, right) => left.localeCompare(right));
}

function parseBooleanFlag(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function buildWindowLabels(windows) {
  return ['Current', ...Array.from({ length: windows }, (_, index) => `C${index + 1}`)];
}

function rankRows(rows, minParticipation, activeNodeSet) {
  return rows
    .filter((row) => activeNodeSet.has(row.node_address))
    .filter((row) => row.participation >= minParticipation)
    .sort((left, right) => {
      if (left.total !== right.total) {
        return left.total - right.total;
      }
      if (left.avg_per_churn !== right.avg_per_churn) {
        return left.avg_per_churn - right.avg_per_churn;
      }
      return left.node_address.localeCompare(right.node_address);
    })
    .map((row, index) => ({
      ...row,
      rank: index + 1
    }));
}

export async function handleNodeopLeaderboard(_request, url) {
  const windows = parseIntegerParam(url.searchParams.get('windows'), 10, { min: 1, max: 10 });
  const listOnly = parseBooleanFlag(url.searchParams.get('list_only'));
  const minParticipation = parseIntegerParam(url.searchParams.get('min_participation'), 3, {
    min: 1,
    max: windows + 1
  });

  const [materializedResult, churnHeightsResult, currentNodes] = await Promise.all([
    query(
      `select node_address, as_of, computed_windows, per_window
       from nodeop_leaderboard_latest
       order by rank asc`
    ),
    query(
      `select height
       from nodeop_churn_events
       order by height desc
       limit $1`,
      [windows + 1]
    ),
    fetchNodes()
  ]);

  const churnHeights = churnHeightsResult.rows
    .map((row) => Number(row?.height) || 0)
    .filter((height) => Number.isFinite(height) && height > 0);

  const latestChurnHeight = churnHeights[0] || 0;
  if (!latestChurnHeight) {
    return error('No churn boundary available for current-window leaderboard.', 500);
  }

  const boundaryResult = await query(
    `select height, node_address, slash_points, status
     from nodeop_boundary_snapshots
     where height = any($1::bigint[])`,
    [churnHeights]
  );

  const churnBoundaryRows = boundaryResult.rows || [];
  const latestBoundaryRows = churnBoundaryRows.filter(
    (row) => Number(row?.height) === latestChurnHeight
  );

  const currentDeltaByNode = buildCurrentDeltaByNode(currentNodes, latestBoundaryRows);
  const currentNodeOperatorMap = buildCurrentNodeOperatorMap(currentNodes);
  const activeNodeSet = buildActiveNodeSet(churnBoundaryRows);
  const activeNodeAddresses = toSortedAddresses(activeNodeSet);

  const materializedRows = materializedResult.rows || [];
  const asOf = materializedRows[0]?.as_of || new Date().toISOString();
  const rowMap = new Map();

  for (const row of materializedRows) {
    const address = String(row.node_address || '');
    if (!address) {
      continue;
    }

    const historicalPerWindow = normalizePerWindow(row, windows);
    const currentDelta = currentDeltaByNode.has(address)
      ? currentDeltaByNode.get(address) ?? 0
      : null;

    rowMap.set(address, {
      node_address: address,
      node_operator_address: currentNodeOperatorMap.get(address) || '',
      per_window: [currentDelta, ...historicalPerWindow]
    });
  }

  for (const [address, currentDelta] of currentDeltaByNode.entries()) {
    if (rowMap.has(address)) {
      continue;
    }

    rowMap.set(address, {
      node_address: address,
      node_operator_address: currentNodeOperatorMap.get(address) || '',
      per_window: [currentDelta, ...Array(windows).fill(null)]
    });
  }

  const rowsToRank = Array.from(rowMap.values()).map((row) => {
    const participation = row.per_window.reduce((count, value) => (value == null ? count : count + 1), 0);
    const total = row.per_window.reduce((sum, value) => (value == null ? sum : sum + value), 0);
    const avgPerChurn = participation > 0 ? total / participation : 0;

    return {
      node_address: row.node_address,
      node_operator_address: row.node_operator_address,
      per_window: row.per_window,
      total,
      avg_per_churn: avgPerChurn,
      participation
    };
  });

  const rows = rankRows(rowsToRank, minParticipation, activeNodeSet);
  const maxComputedWindows = materializedRows.reduce((max, row) => {
    const parsed = Number(row.computed_windows) || 0;
    return Math.max(max, parsed);
  }, 0);

  const responseBase = {
    as_of: toIsoString(asOf),
    requested_windows: windows,
    computed_windows: Math.min(windows, maxComputedWindows),
    window_labels: buildWindowLabels(windows),
    active_node_addresses: activeNodeAddresses
  };

  if (listOnly) {
    return json(
      {
        ...responseBase,
        rows: []
      },
      200,
      {
        'Cache-Control': 'public, max-age=60'
      }
    );
  }

  return json(
    {
      ...responseBase,
      rows
    },
    200,
    {
      'Cache-Control': 'public, max-age=60'
    }
  );
}
