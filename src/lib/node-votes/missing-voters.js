export function findMissingVoters(activeNodes, voteValues) {
  const currentVoters = new Set(
    (Array.isArray(voteValues) ? voteValues : [])
      .flatMap((value) => (Array.isArray(value?.nodes) ? value.nodes : []))
      .filter(Boolean)
  );

  return (Array.isArray(activeNodes) ? activeNodes : [])
    .filter((node) => node?.node_address && !currentVoters.has(node.node_address));
}
