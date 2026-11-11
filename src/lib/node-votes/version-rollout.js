// A patch release has no on-chain proposal: operators update their nodes and
// THORNode derives the network version from the active set. Rules from
// x/thorchain/keeper/v1/keeper_node_account.go at v3.21.1:
// - GetMinJoinVersion: the highest version that a supermajority of active
//   validators run or exceed (later versions count toward earlier ones).
// - GetLowestActiveVersion: the network's active version is the lowest
//   version any active validator runs, so it moves only when all have updated.
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function parts(version) {
  const match = VERSION.exec(String(version ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** THORNode HasSuperMajority: at least two thirds, rounded up. */
export function superMajority(total) {
  return Math.ceil((total * 2) / 3);
}

/**
 * One row per release that some active validators run ahead of the network,
 * shaped like a vote-key row so the vote table can render it.
 * @param {{ nodes?: any[], networkVersion?: string }} [input]
 */
export function buildVersionRolloutRows({ nodes, networkVersion } = {}) {
  const current = parts(networkVersion);
  const active = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => node?.status === 'Active' && node?.node_address)
    .map((node) => ({
      node_address: node.node_address,
      operator_address: node.node_operator_address || node.operator_address || '',
      version: String(node.version ?? '').trim(),
      parsed: parts(node.version)
    }));
  if (!current || !active.length) return [];

  const byVersion = new Map();
  for (const node of active) {
    const key = node.parsed ? node.version : 'unknown';
    if (!byVersion.has(key)) byVersion.set(key, []);
    byVersion.get(key).push(node);
  }
  const values = [...byVersion.entries()]
    .map(([value, group]) => ({ value, parsed: parts(value), group }))
    .sort((left, right) => (
      !left.parsed ? 1 : !right.parsed ? -1 : compare(right.parsed, left.parsed)
    ))
    .map(({ value, group }) => ({
      value,
      count: group.length,
      nodes: group.map((node) => node.node_address),
      operators: [...new Set(group.map((node) => node.operator_address).filter(Boolean))]
    }));

  const total = active.length;
  const threshold = superMajority(total);
  return values
    .filter((value) => parts(value.value) && compare(parts(value.value), current) > 0)
    .map(({ value: target }) => {
      const targetParts = parts(target);
      const updated = active.filter((node) => node.parsed && compare(node.parsed, targetParts) >= 0).length;
      return {
        mimir_key: `VERSION-${target}`,
        vote_key: `VERSION-${target}`,
        vote_kind: 'version',
        vote_category: 'version',
        mimir_category: 'version',
        consensus_model: 'version-rollout',
        current_vote_source: 'node-versions',
        leader_value: target,
        leader_count: updated,
        values,
        consensus_threshold: total,
        votes_to_consensus: total - updated,
        consensus_ready: false,
        latest_vote_at: null,
        latest_height: 0,
        rollout: {
          target,
          current: String(networkVersion).trim(),
          updated,
          total,
          remaining: total - updated,
          superMajority: threshold,
          toSuperMajority: Math.max(0, threshold - updated),
          minVersionReached: updated >= threshold
        },
        active_nodes: active.map(({ node_address, operator_address }) => ({ node_address, operator_address }))
      };
    });
}
