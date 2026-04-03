export function mergePendingCandidateBatches(batches, limit) {
  const maxRows = Math.max(0, Math.trunc(limit || 0));
  if (maxRows === 0) {
    return [];
  }

  const merged = [];
  const seen = new Set();

  for (const batch of batches) {
    for (const row of batch || []) {
      const hintKey = String(row?.hint_key || '');
      if (!hintKey || seen.has(hintKey)) {
        continue;
      }

      seen.add(hintKey);
      merged.push(row);

      if (merged.length >= maxRows) {
        return merged;
      }
    }
  }

  return merged;
}
