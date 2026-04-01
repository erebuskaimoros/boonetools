export function normalizeBoundarySnapshot(nodes) {
  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes
    .filter((node) => Boolean(node?.node_address))
    .map((node) => ({
      node_address: String(node.node_address),
      slash_points: Number(node.slash_points) || 0,
      status: String(node.status || '')
    }));
}

function buildSlashMap(snapshot) {
  const map = new Map();

  for (const row of snapshot || []) {
    map.set(row.node_address, Number(row.slash_points) || 0);
  }

  return map;
}

export function computeLeaderboardRows(options = {}) {
  const churnHeights = Array.isArray(options.churnHeights) ? options.churnHeights : [];
  const snapshotsByHeight = options.snapshotsByHeight || {};
  const endSnapshotsByHeight = options.endSnapshotsByHeight || snapshotsByHeight;
  const minParticipation = Number(options.minParticipation ?? 3);
  const maxWindows = Number(options.maxWindows ?? 10);

  const requestedWindows = Math.min(maxWindows, Math.max(0, churnHeights.length - 1));
  const rowsByNode = new Map();

  let computedWindows = 0;

  for (let windowIndex = 0; windowIndex < requestedWindows; windowIndex += 1) {
    const endHeight = Number(churnHeights[windowIndex]);
    const startHeight = Number(churnHeights[windowIndex + 1]);

    const endSnapshot = endSnapshotsByHeight[endHeight];
    const startSnapshot = snapshotsByHeight[startHeight];

    if (!Array.isArray(endSnapshot) || !Array.isArray(startSnapshot)) {
      continue;
    }

    computedWindows += 1;

    const startSlashMap = buildSlashMap(startSnapshot);

    for (const node of endSnapshot) {
      const nodeAddress = node.node_address;
      const endSlash = Number(node.slash_points) || 0;
      const startSlash = startSlashMap.get(nodeAddress) ?? 0;
      const delta = Math.max(0, endSlash - startSlash);

      if (!rowsByNode.has(nodeAddress)) {
        rowsByNode.set(nodeAddress, {
          node_address: nodeAddress,
          perWindow: Array(maxWindows).fill(null),
          total: 0,
          avgPerChurn: 0,
          participation: 0
        });
      }

      const row = rowsByNode.get(nodeAddress);
      row.perWindow[windowIndex] = delta;
      row.total += delta;
      row.participation += 1;
    }
  }

  const rows = Array.from(rowsByNode.values())
    .filter((row) => row.participation >= minParticipation)
    .map((row) => ({
      ...row,
      avgPerChurn: row.participation > 0 ? row.total / row.participation : 0
    }))
    .sort((left, right) => {
      if (left.total !== right.total) {
        return left.total - right.total;
      }
      if (left.avgPerChurn !== right.avgPerChurn) {
        return left.avgPerChurn - right.avgPerChurn;
      }
      return left.node_address.localeCompare(right.node_address);
    })
    .map((row, index) => ({
      ...row,
      rank: index + 1
    }));

  return {
    rows,
    requestedWindows,
    computedWindows
  };
}
