const VOTE_DETAIL_FIELDS = ['node_votes', 'vote_history', 'detail_pagination'];
const NODE_DETAIL_FIELDS = ['vote_history', 'detail_pagination'];

function mergeRows(currentRows, refreshedRows, identityField, detailFields) {
  if (!Array.isArray(refreshedRows)) return refreshedRows;

  const currentByIdentity = new Map(
    (Array.isArray(currentRows) ? currentRows : []).map((row) => [row?.[identityField], row])
  );

  return refreshedRows.map((refreshedRow) => {
    const currentRow = currentByIdentity.get(refreshedRow?.[identityField]);
    if (!currentRow) return refreshedRow;

    const mergedRow = { ...refreshedRow };
    for (const field of detailFields) {
      if (!Object.hasOwn(refreshedRow, field) && Object.hasOwn(currentRow, field)) {
        mergedRow[field] = currentRow[field];
      }
    }
    return mergedRow;
  });
}

export function mergeNodeVotesDashboard(currentDashboard, refreshedDashboard) {
  if (!refreshedDashboard || typeof refreshedDashboard !== 'object') {
    return refreshedDashboard;
  }

  return {
    ...refreshedDashboard,
    by_vote: mergeRows(
      currentDashboard?.by_vote,
      refreshedDashboard.by_vote,
      'mimir_key',
      VOTE_DETAIL_FIELDS
    ),
    by_node: mergeRows(
      currentDashboard?.by_node,
      refreshedDashboard.by_node,
      'node_address',
      NODE_DETAIL_FIELDS
    )
  };
}
