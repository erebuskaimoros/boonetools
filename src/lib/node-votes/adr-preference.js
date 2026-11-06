import { adrNumber } from '../../../shared/node-votes/keys.js';
export { adrNumber } from '../../../shared/node-votes/keys.js';

/** @typedef {{ key: string, count: number, complete: boolean }} AdrVariant */
/** @typedef {{ number: number, variants: AdrVariant[], complete: boolean,
 * preferred: string | null, count: number | null,
 * state: 'unavailable' | 'no-votes' | 'tied' | 'preferred' | 'alternate' }} AdrPreference */

/** Rank spellings by distinct current active validators, across all vote values.
 * Use the full dashboard before filtering/sorting. Historical event counts and
 * stored stances cannot establish the currently preferred spelling.
 */
export function buildAdrPreferences(rows, activeNodes, chainStateComplete = false) {
  const active = new Set((activeNodes || []).map((node) => node.node_address).filter(Boolean));
  const groups = new Map();
  for (const row of rows || []) {
    const key = row.mimir_key || row.vote_key;
    const number = adrNumber(key);
    if (number == null) continue;
    if (!groups.has(number)) groups.set(number, new Map());
    const voters = new Set();
    let complete = chainStateComplete && active.size > 0
      && row.current_vote_source === 'thornode-active-node-mimir';
    for (const value of row.values || []) {
      if (value.value == null || Number(value.value) < 0) continue;
      if (Number(value.count) > (value.nodes || []).length) complete = false;
      for (const node of value.nodes || []) if (active.has(node)) voters.add(node);
    }
    groups.get(number).set(key, { key, count: voters.size, complete });
  }

  /** @type {Record<string, AdrPreference>} */
  const byKey = {};
  for (const [number, group] of groups) {
    const variants = [...group.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    const complete = variants.every((variant) => variant.complete);
    const max = variants[0].count;
    const leaders = complete && max > 0 ? variants.filter((variant) => variant.count === max) : [];
    const preferred = leaders.length === 1 ? leaders[0].key : null;
    for (const variant of variants) {
      byKey[variant.key] = {
        number, variants, complete, preferred,
        count: complete ? variant.count : null,
        state: !complete ? 'unavailable' : max === 0 ? 'no-votes'
          : leaders.length > 1 ? 'tied' : variant.key === preferred ? 'preferred' : 'alternate'
      };
    }
  }
  return byKey;
}
