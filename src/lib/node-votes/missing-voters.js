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
