import { createClient } from 'npm:@supabase/supabase-js@2';
import { fetchNodes } from '../_shared/thornode.ts';
import {
  CORS_HEADERS,
  errorResponse,
  jsonResponse,
  parseIntegerParam,
  requireMethod
} from '../_shared/validation.ts';

type MaterializedRow = {
  node_address: string;
  as_of: string;
  computed_windows: number;
  per_window: Array<number | null>;
};

type BoundarySnapshotRow = {
  height: number;
  node_address: string;
  slash_points: number;
  status: string;
};

type RankedRow = {
  rank: number;
  node_address: string;
  node_operator_address: string;
  per_window: Array<number | null>;
  total: number;
  avg_per_churn: number;
  participation: number;
};

function createAdminClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function normalizePerWindow(row: MaterializedRow, windows: number): Array<number | null> {
  const input = Array.isArray(row.per_window) ? row.per_window : [];
  const output = Array(windows).fill(null) as Array<number | null>;

  for (let i = 0; i < windows; i += 1) {
    const value = input[i];
    if (value == null) {
      output[i] = null;
      continue;
    }

    const parsed = Number(value);
    output[i] = Number.isFinite(parsed) ? parsed : null;
  }

  return output;
}

function buildBoundarySlashMap(rows: BoundarySnapshotRow[]): Map<string, number> {
  const map = new Map<string, number>();

  for (const row of rows || []) {
    const address = String(row?.node_address || '');
    if (!address) continue;
    map.set(address, Number(row?.slash_points) || 0);
  }

  return map;
}

function normalizeStatus(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function buildCurrentDeltaByNode(
  currentNodes: any[],
  boundaryRows: BoundarySnapshotRow[]
): Map<string, number> {
  const boundarySlashMap = buildBoundarySlashMap(boundaryRows);
  const deltaMap = new Map<string, number>();

  for (const node of currentNodes || []) {
    const address = String(node?.node_address || '');
    if (!address) continue;

    const currentSlash = Number(node?.slash_points) || 0;
    const boundarySlash = boundarySlashMap.get(address) ?? 0;
    const delta = Math.max(0, currentSlash - boundarySlash);

    deltaMap.set(address, delta);
  }

  return deltaMap;
}

function buildCurrentNodeOperatorMap(currentNodes: any[]): Map<string, string> {
  const map = new Map<string, string>();

  for (const node of currentNodes || []) {
    const address = String(node?.node_address || '');
    if (!address) continue;
    map.set(address, String(node?.node_operator_address || ''));
  }

  return map;
}

function buildActiveNodeSet(churnBoundaryRows: BoundarySnapshotRow[]): Set<string> {
  const active = new Set<string>();

  for (const row of churnBoundaryRows || []) {
    const address = String(row?.node_address || '');
    if (!address) continue;
    if (normalizeStatus(row?.status) === 'active') {
      active.add(address);
    }
  }

  return active;
}

function toSortedAddresses(values: Set<string>): string[] {
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function parseBooleanFlag(value: string | null): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function buildWindowLabels(windows: number): string[] {
  return ['Current', ...Array.from({ length: windows }, (_, idx) => `C${idx + 1}`)];
}

function rankRows(
  rows: Array<Omit<RankedRow, 'rank'>>,
  minParticipation: number,
  activeNodeSet: Set<string>
): RankedRow[] {
  return rows
    .filter((row) => activeNodeSet.has(row.node_address))
    .filter((row) => row.participation >= minParticipation)
    .sort((a, b) => {
      if (a.total !== b.total) return a.total - b.total;
      if (a.avg_per_churn !== b.avg_per_churn) return a.avg_per_churn - b.avg_per_churn;
      return a.node_address.localeCompare(b.node_address);
    })
    .map((row, index) => ({
      ...row,
      rank: index + 1
    }));
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const methodError = requireMethod(request, 'GET');
  if (methodError) {
    return errorResponse(methodError, 405);
  }

  try {
    const url = new URL(request.url);
    const windows = parseIntegerParam(url.searchParams.get('windows'), 10, { min: 1, max: 10 });
    const listOnly = parseBooleanFlag(url.searchParams.get('list_only'));
    const minParticipation = parseIntegerParam(url.searchParams.get('min_participation'), 3, {
      min: 1,
      max: windows + 1
    });

    const supabase = createAdminClient();
    const [materializedResult, churnHeightsResult, currentNodes] = await Promise.all([
      supabase
        .from('nodeop_leaderboard_latest')
        .select('node_address,as_of,computed_windows,per_window')
        .order('rank', { ascending: true }),
      supabase
        .from('nodeop_churn_events')
        .select('height')
        .order('height', { ascending: false })
        .limit(windows + 1),
      fetchNodes()
    ]);

    if (materializedResult.error) {
      throw new Error(materializedResult.error.message);
    }

    if (churnHeightsResult.error) {
      throw new Error(churnHeightsResult.error.message);
    }

    const churnHeights = (churnHeightsResult.data || [])
      .map((row) => Number(row?.height) || 0)
      .filter((height) => Number.isFinite(height) && height > 0);

    const latestChurnHeight = churnHeights[0] || 0;
    if (!latestChurnHeight) {
      throw new Error('No churn boundary available for current-window leaderboard.');
    }

    const { data: boundaryRowsRaw, error: boundaryError } = await supabase
      .from('nodeop_boundary_snapshots')
      .select('height,node_address,slash_points,status')
      .in('height', churnHeights);

    if (boundaryError) {
      throw new Error(boundaryError.message);
    }

    const churnBoundaryRows = (boundaryRowsRaw || []) as BoundarySnapshotRow[];
    const latestBoundaryRows = churnBoundaryRows.filter(
      (row) => Number(row?.height) === latestChurnHeight
    );

    const currentDeltaByNode = buildCurrentDeltaByNode(currentNodes, latestBoundaryRows);
    const currentNodeOperatorMap = buildCurrentNodeOperatorMap(currentNodes);
    const activeNodeSet = buildActiveNodeSet(churnBoundaryRows);
    const activeNodeAddresses = toSortedAddresses(activeNodeSet);

    const materializedRows = (materializedResult.data || []) as MaterializedRow[];
    const asOf = materializedRows[0]?.as_of || new Date().toISOString();

    const rowMap = new Map<
      string,
      { node_address: string; node_operator_address: string; per_window: Array<number | null> }
    >();

    for (const row of materializedRows) {
      const address = String(row.node_address || '');
      if (!address) continue;

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
      const participation = row.per_window.reduce((acc, value) => (value == null ? acc : acc + 1), 0);
      const total = row.per_window.reduce((acc, value) => (value == null ? acc : acc + value), 0);
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

    const maxComputedWindows = materializedRows.reduce((acc, row) => {
      const parsed = Number(row.computed_windows) || 0;
      return Math.max(acc, parsed);
    }, 0);

    const responseBase = {
      as_of: asOf,
      requested_windows: windows,
      computed_windows: Math.min(windows, maxComputedWindows),
      window_labels: buildWindowLabels(windows),
      active_node_addresses: activeNodeAddresses
    };

    if (listOnly) {
      return jsonResponse(
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

    return jsonResponse(
      {
        ...responseBase,
        rows
      },
      200,
      {
        'Cache-Control': 'public, max-age=60'
      }
    );
  } catch (error) {
    console.error('nodeop-leaderboard failed:', error);
    return errorResponse((error as Error).message || 'Failed to load leaderboard', 500);
  }
});
