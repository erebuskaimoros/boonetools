const MAX_AGE_MS = 5 * 60 * 1000;

export function selectReusableBondNode(nodes, address, meta = {}, nowMs = Date.now()) {
  const observed = Date.parse(meta?.fetched_at || '');
  if (!['fresh', 'cached'].includes(meta?.status) || !Number.isFinite(observed)
    || observed > nowMs || nowMs - observed > MAX_AGE_MS) return null;
  const node = (Array.isArray(nodes) ? nodes : []).find((row) => row.node_address === address);
  if (!node || !Array.isArray(node.bond_providers?.providers)
    || !/^\d+$/.test(String(node.bond_providers.node_operator_fee ?? ''))
    || !/^\d+$/.test(String(node.current_award ?? ''))) return null;
  return node;
}
