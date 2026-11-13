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

const KEY_PARAM = 'key';
const MAX_KEY_FILTER_LENGTH = 120;

/** The pre-filter from a `?key=` link, e.g. `/vote-tracker?key=ADR030`. */
export function voteTrackerKeyFilter(search) {
  const value = new URLSearchParams(String(search ?? '')).get(KEY_PARAM);
  return String(value ?? '').trim().slice(0, MAX_KEY_FILTER_LENGTH);
}

/** The query string with `key` set to the filter, or removed when it is empty. */
export function voteTrackerSearchWithKey(search, filter) {
  const params = new URLSearchParams(String(search ?? ''));
  const value = String(filter ?? '').trim().slice(0, MAX_KEY_FILTER_LENGTH);
  if (value) params.set(KEY_PARAM, value);
  else params.delete(KEY_PARAM);
  const query = params.toString();
  return query ? `?${query}` : '';
}
