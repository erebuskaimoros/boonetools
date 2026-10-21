import { config } from '../lib/config.js';
import { acquireCached } from './acquisition-cache.js';
import { fetchThorchainRpc } from './rpc.js';
import { historicalBondHeight } from './bond-history-rpc.js';

function decoded(value) {
  const text = String(value ?? '');
  const candidate = Buffer.from(text, 'base64').toString('utf8');
  return text && Buffer.from(candidate).toString('base64') === text && /^[\x20-\x7e]+$/.test(candidate) ? candidate : text;
}

/** Operator fees are empty-tx bond_returned events immediately after a node's
 * bond_reward. Ordinary unbonds have an inbound tx; bond-yield payouts must not
 * be mistaken for operator fees. Keep the reward/return pairing explicit. */
export function parseChurnOperatorFees(payload, expectedHeight) {
  const result = payload?.result;
  const height = historicalBondHeight(result?.height);
  if (height !== historicalBondHeight(expectedHeight) || payload.error) throw new Error('Invalid operator-fee block height');
  const finalize = result.result_finalize_block ?? result.result_end_block ?? result;
  let events = finalize.events ?? finalize.finalize_block_events;
  if (!events && Object.hasOwn(finalize, 'begin_block_events') && Object.hasOwn(finalize, 'end_block_events')) {
    events = [...(finalize.begin_block_events || []), ...(finalize.end_block_events || [])];
  }
  if (!Array.isArray(events)) throw new Error('Operator-fee block events unavailable');
  const payouts = [];
  const rewarded = new Set();
  let precedingReward = '';
  for (const event of events) {
    if (decoded(event.type) !== 'bond') continue;
    if (!Array.isArray(event.attributes)) throw new Error('Invalid bond event attributes');
    const attrs = {};
    for (const attribute of event.attributes) {
      const key = decoded(attribute.key);
      if (Object.hasOwn(attrs, key)) throw new Error('Duplicate bond event attribute');
      attrs[key] = decoded(attribute.value);
    }
    const previous = precedingReward;
    precedingReward = '';
    if (attrs.bond_type === 'bond_reward' && attrs.id === '' && attrs.node_address) {
      if (rewarded.has(attrs.node_address)) throw new Error('Duplicate churn reward');
      rewarded.add(attrs.node_address);
      precedingReward = attrs.node_address;
    } else if (attrs.bond_type === 'bond_returned' && attrs.id === '' && previous && attrs.node_address === previous) {
      if (!attrs.bond_address || !/^\d+$/.test(attrs.amount || '')) throw new Error('Incomplete operator-fee payout');
      payouts.push({ node: attrs.node_address, address: attrs.bond_address, amount: attrs.amount });
    }
  }
  // An empty or pruned result cannot prove zero fees for a churn.
  if (!rewarded.size) throw new Error('Churn reward events unavailable');
  return { height, payouts };
}

export async function loadChurnOperatorFee(bondAddress, nodeAddresses, height, options = {}) {
  height = historicalBondHeight(height);
  const observation = await (options.acquireCached || acquireCached)(options.client, {
    namespace: 'thorchain-mainnet:churn-operator-fees:v1', identity: String(height),
    source: 'thorchain-rpc:block_results', immutable: true,
    validate: (value) => value?.height === height && Array.isArray(value.payouts)
      && value.payouts.every((row) => row.node && row.address && /^\d+$/.test(row.amount)),
    load: async (client) => parseChurnOperatorFees(await (options.fetchThorchainRpc || fetchThorchainRpc)(
      '/block_results', { height: String(height) }, {
        rpcUrls: options.rpcUrls || [...new Set([...config.rpcRestUrls, config.rpcArchiveRestUrl].filter(Boolean))],
        cooldownClient: client, sharedCooldown: true
      }), height)
  });
  const nodes = new Set(nodeAddresses);
  const candidates = observation.payload.payouts.filter((row) => row.address === bondAddress && nodes.has(row.node));
  if (!candidates.length) return '0';
  // Confirm historical ownership too: future provider-yield returns must never
  // become an operator fee just because they follow a zero-fee node's reward.
  const loadNode = options.loadNode || (await import('./bond-history-acquisition.js')).fetchNodeAtHeight;
  let total = 0n;
  for (const payout of candidates) {
    const node = await loadNode(payout.node, height - 1, options);
    // THORNode BondProviders.Adjust reserves providers[0] for the operator.
    // Older verified RPC cache entries omit QueryNode field 8 but retain order.
    const operator = node.node_operator_address || node.bond_providers?.providers?.[0]?.bond_address;
    if (!operator) throw new Error('Historical operator identity unavailable');
    if (operator === bondAddress && Number(node.bond_providers.node_operator_fee) > 0) total += BigInt(payout.amount);
  }
  return total.toString();
}

/** Bounded metadata backfill. Never recalculate or replace existing bond values. */
export async function backfillOperatorFees(bondAddress, nodes, rows, options = {}) {
  const pending = rows.filter((row) => row.operator_fee == null).sort((a, b) => Number(b.churn_height) - Number(a.churn_height));
  const updated = [];
  for (const row of pending.slice(0, options.limit ?? 25)) {
    try {
      const fee = await (options.loadFee || loadChurnOperatorFee)(bondAddress, nodes, Number(row.churn_height), options);
      row.operator_fee = fee;
      updated.push(row);
    } catch {
      break; // Respect upstream cooldowns and leave unavailable fees null for retry.
    }
  }
  return { updated, complete: updated.length === pending.length,
    continuing: updated.length < pending.length && updated.length === (options.limit ?? 25) };
}
