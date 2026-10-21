/**
 * Tracked-address helpers for the Position Tracker.
 *
 * Addresses are kept as a small ordered list of { address, label, chain }
 * entries. THOR addresses are lowercased; other chains keep their case
 * because base58 formats (BTC legacy, SOL) are case-sensitive.
 */

export const STORAGE_KEY = 'position_tracker_addresses';
export const LEGACY_BOND_KEY = 'bond_tracker_address';
export const MAX_TRACKED_ADDRESSES = 25;

/** @type {Array<[string, RegExp]>} */
const CHAIN_PATTERNS = [
  ['THOR', /^thor1[02-9ac-hj-np-z]{38}([02-9ac-hj-np-z]{20})?$/],
  ['GAIA', /^cosmos1[02-9ac-hj-np-z]{38}$/],
  ['BTC', /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/],
  ['LTC', /^(ltc1[02-9ac-hj-np-z]{11,71}|[LM3][1-9A-HJ-NP-Za-km-z]{26,33})$/],
  ['DOGE', /^D[1-9A-HJ-NP-Za-km-z]{25,34}$/],
  ['BCH', /^(bitcoincash:)?[qp][02-9ac-hj-np-z]{41}$/],
  ['EVM', /^0x[0-9a-fA-F]{40}$/],
  ['TRON', /^T[1-9A-HJ-NP-Za-km-z]{33}$/],
  ['XRP', /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/],
  ['ZEC', /^t1[1-9A-HJ-NP-Za-km-z]{33}$/],
  ['SOL', /^[1-9A-HJ-NP-Za-km-z]{32,44}$/]
];

/** Best-effort chain label for an address; '' when it matches nothing. */
export function detectAddressChain(address) {
  const value = String(address ?? '').trim();
  if (!value) return '';
  const lower = value.toLowerCase();
  for (const [chain, pattern] of CHAIN_PATTERNS) {
    const candidate = chain === 'THOR' || chain === 'GAIA' || chain === 'BCH' ? lower : value;
    if (pattern.test(candidate)) return chain;
  }
  return '';
}

export function normalizeTrackedAddress(address) {
  const value = String(address ?? '').trim();
  const chain = detectAddressChain(value);
  if (chain === 'THOR' || chain === 'GAIA' || chain === 'BCH') return value.toLowerCase();
  if (chain === 'EVM') return value.toLowerCase();
  return value;
}

export function isThorAddress(address) {
  return detectAddressChain(address) === 'THOR';
}

/** Pick a distinct funded bond provider, ignoring inactive nodes and dust. */
export function pickRandomBondAddress(nodes, rng = Math.random) {
  const providers = new Set();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node?.status !== 'Active') continue;
    const entries = node.bond_providers?.providers;
    for (const provider of Array.isArray(entries) ? entries : []) {
      const address = normalizeTrackedAddress(provider?.bond_address);
      const bond = Number(provider?.bond);
      if (isThorAddress(address) && Number.isFinite(bond) && bond > 1e8) providers.add(address);
    }
  }
  const candidates = [...providers];
  if (!candidates.length) return '';
  const draw = Number(rng());
  const index = Number.isFinite(draw) ? Math.min(candidates.length - 1, Math.max(0, Math.floor(draw * candidates.length))) : 0;
  return candidates[index];
}

/** Split free-form input (commas, whitespace, newlines) into candidate addresses. */
export function splitAddressInput(input) {
  return String(input ?? '')
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeEntry(entry) {
  const raw = typeof entry === 'string' ? entry : entry?.address;
  const address = normalizeTrackedAddress(raw);
  const chain = detectAddressChain(address);
  if (!address || !chain) return null;
  const label = typeof entry === 'object' && entry?.label ? String(entry.label).trim().slice(0, 32) : '';
  return { address, chain, label };
}

/**
 * Merge new addresses into an existing list.
 * Returns { list, added, rejected } where rejected holds unrecognized input.
 */
export function addAddresses(list, input, label = '') {
  const current = (Array.isArray(list) ? list : []).map(normalizeEntry).filter(Boolean);
  const seen = new Set(current.map((entry) => entry.address));
  const added = [];
  const rejected = [];

  for (const candidate of splitAddressInput(input)) {
    const entry = normalizeEntry({ address: candidate, label });
    if (!entry) {
      rejected.push(candidate);
      continue;
    }
    if (seen.has(entry.address)) continue;
    if (current.length + added.length >= MAX_TRACKED_ADDRESSES) {
      rejected.push(candidate);
      continue;
    }
    seen.add(entry.address);
    added.push(entry);
  }

  return { list: [...current, ...added], added, rejected };
}

export function removeAddress(list, address) {
  const target = normalizeTrackedAddress(address);
  return (Array.isArray(list) ? list : []).filter((entry) => entry.address !== target);
}

export function relabelAddress(list, address, label) {
  const target = normalizeTrackedAddress(address);
  return (Array.isArray(list) ? list : []).map((entry) => (
    entry.address === target ? { ...entry, label: String(label ?? '').trim().slice(0, 32) } : entry
  ));
}

export function displayAddress(entry) {
  const address = entry?.address || '';
  const suffix = address.slice(-4);
  return entry?.label ? `${entry.label} …${suffix}` : `${address.slice(0, 6)}…${suffix}`;
}

/**
 * An explicit `addresses=a,b` URL defines the displayed portfolio, keeping
 * matching saved labels. Otherwise seed saved addresses with a legacy
 * `bond_address` param or the single-address Bond Tracker storage key.
 *
 * @param {{ storage?: Pick<Storage, 'getItem'> | null, search?: string }} [options]
 */
export function loadTrackedAddresses({ storage, search = '' } = {}) {
  let list = [];
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (stored) list = JSON.parse(stored);
  } catch {
    list = [];
  }
  list = (Array.isArray(list) ? list : []).map(normalizeEntry).filter(Boolean);

  const params = new URLSearchParams(search);
  if (params.has('addresses')) {
    const savedLabels = new Map(list.map((entry) => [entry.address, entry.label]));
    return addAddresses([], params.get('addresses')).list.map((entry) => ({
      ...entry, label: savedLabels.get(entry.address) || ''
    }));
  }
  const fromUrl = params.get('bond_address');
  if (fromUrl) list = addAddresses(list, fromUrl).list;

  if (list.length === 0) {
    try {
      const legacy = storage?.getItem(LEGACY_BOND_KEY);
      if (legacy) list = addAddresses(list, legacy).list;
    } catch {
      // storage unavailable
    }
  }

  return list;
}

/** @param {any[]} list @param {Pick<Storage, 'setItem'> | null} [storage] */
export function saveTrackedAddresses(list, storage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable
  }
}
