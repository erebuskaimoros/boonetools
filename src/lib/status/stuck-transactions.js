function normalizedChain(value) {
  return String(value || '').trim().toUpperCase() || 'UNKNOWN';
}

function overdueBlocks(transaction) {
  const value = Number(transaction?.overdue_blocks || 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function compareTransactions(left, right) {
  const overdueDifference = overdueBlocks(right) - overdueBlocks(left);
  if (overdueDifference !== 0) return overdueDifference;
  return String(left?.tx_id || '').localeCompare(String(right?.tx_id || ''));
}

export function groupStuckTransactionsByChain(transactions) {
  if (!Array.isArray(transactions)) return [];

  const byChain = new Map();
  for (const transaction of transactions) {
    const chain = normalizedChain(transaction?.chain);
    if (!byChain.has(chain)) byChain.set(chain, []);
    byChain.get(chain).push(transaction);
  }

  return [...byChain.entries()]
    .map(([chain, chainTransactions]) => {
      const sortedTransactions = [...chainTransactions].sort(compareTransactions);
      const stageLabels = [...new Set(sortedTransactions.map((transaction) => (
        String(transaction?.stage_label || '').trim() || 'Unknown stage'
      )))];
      return {
        chain,
        count: sortedTransactions.length,
        maxOverdueBlocks: sortedTransactions.reduce(
          (maximum, transaction) => Math.max(maximum, overdueBlocks(transaction)),
          0
        ),
        stageLabels,
        transactions: sortedTransactions
      };
    })
    .sort((left, right) => (
      right.maxOverdueBlocks - left.maxOverdueBlocks
      || left.chain.localeCompare(right.chain)
    ));
}
