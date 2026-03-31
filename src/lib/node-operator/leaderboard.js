export function getLeaderboardCellClass(value) {
  if (value == null) return 'cell-empty';
  if (value === 0) return 'cell-good';
  if (value <= 50) return 'cell-warn';
  return 'cell-bad';
}

export function normalizeLeaderboardRows(rows, windows = null) {
  if (!Array.isArray(rows)) {
    return [];
  }

  const fallbackWindows = rows.reduce((max, row) => {
    const values = Array.isArray(row?.per_window)
      ? row.per_window
      : (Array.isArray(row?.perWindow) ? row.perWindow : []);
    return Math.max(max, values.length);
  }, 0);

  const windowCount = Number.isFinite(Number(windows)) && Number(windows) > 0
    ? Number(windows)
    : fallbackWindows;

  return rows
    .filter((row) => Boolean(row?.node_address))
    .map((row, index) => {
      const perWindowRaw = Array.isArray(row.per_window)
        ? row.per_window
        : (Array.isArray(row.perWindow) ? row.perWindow : []);

      const perWindow = Array.from({ length: windowCount }, (_, idx) => {
        const value = perWindowRaw[idx];
        if (value == null) return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      });

      const participation = Number(row.participation);
      const total = Number(row.total);
      const avgPerChurn = Number(row.avg_per_churn ?? row.avgPerChurn);
      const rank = Number(row.rank);
      const nodeOperatorAddress = String(row.node_operator_address ?? row.nodeOperatorAddress ?? '');

      return {
        rank: Number.isFinite(rank) && rank > 0 ? rank : index + 1,
        node_address: row.node_address,
        node_operator_address: nodeOperatorAddress,
        perWindow,
        total: Number.isFinite(total) ? total : 0,
        avgPerChurn: Number.isFinite(avgPerChurn) ? avgPerChurn : 0,
        participation: Number.isFinite(participation) ? participation : 0
      };
    });
}
