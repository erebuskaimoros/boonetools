export function findMissingVoters(activeNodes, voteValues, nodeVotes) {
  const currentVoters = new Set(Array.isArray(nodeVotes)
    ? nodeVotes
        .filter((vote) => !vote?.vote_removed && vote?.vote_value != null)
        .map((vote) => vote?.node_address)
        .filter(Boolean)
    : (Array.isArray(voteValues) ? voteValues : [])
        .flatMap((value) => (Array.isArray(value?.nodes) ? value.nodes : []))
        .filter(Boolean));

  return (Array.isArray(activeNodes) ? activeNodes : [])
    .filter((node) => node?.node_address && !currentVoters.has(node.node_address));
}

export function groupActiveVotersByValue(activeNodes, voteValues, nodeVotes) {
  const active = (Array.isArray(activeNodes) ? activeNodes : [])
    .filter((node) => node?.node_address);
  const activeAddresses = new Set(active.map((node) => node.node_address));
  const stanceByNode = new Map();

  for (const value of Array.isArray(voteValues) ? voteValues : []) {
    if (value?.value == null) continue;
    for (const nodeAddress of Array.isArray(value.nodes) ? value.nodes : []) {
      if (activeAddresses.has(nodeAddress) && !stanceByNode.has(nodeAddress)) {
        stanceByNode.set(nodeAddress, String(value.value));
      }
    }
  }

  for (const vote of Array.isArray(nodeVotes) ? nodeVotes : []) {
    if (!activeAddresses.has(vote?.node_address)) continue;
    if (vote.vote_removed || vote.vote_value == null) {
      stanceByNode.delete(vote.node_address);
    } else {
      stanceByNode.set(vote.node_address, String(vote.vote_value));
    }
  }

  const votersByValue = new Map();
  for (const node of active) {
    const value = stanceByNode.get(node.node_address);
    if (value == null) continue;
    if (!votersByValue.has(value)) votersByValue.set(value, []);
    votersByValue.get(value).push(node);
  }

  const groups = [...votersByValue.entries()]
    .map(([value, voters]) => ({
      value,
      count: voters.length,
      voters,
      is_missing: false
    }))
    .sort((left, right) => (
      right.count - left.count || String(left.value).localeCompare(String(right.value))
    ));
  const missingVoters = active.filter((node) => !stanceByNode.has(node.node_address));

  if (missingVoters.length) {
    groups.push({
      value: null,
      count: missingVoters.length,
      voters: missingVoters,
      is_missing: true
    });
  }

  return groups;
}
