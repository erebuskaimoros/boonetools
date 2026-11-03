import { bondYieldTarget, requireBondYieldAddress, requireBondYieldName } from './bond-yield.js';

/** Manual entry uses the same authority/expiry rules as discovered names. */
export async function loadBondYieldName(thornode, owner, value) {
  const name = requireBondYieldName(value);
  const address = requireBondYieldAddress(owner, 'Bond provider');
  const options = { cache: false, coreSnapshot: false };
  const [record, blocks] = await Promise.all([
    thornode.fetch(`/thorchain/thorname/${encodeURIComponent(name)}`, options),
    thornode.fetch('/thorchain/lastblock', options)
  ]);
  if (String(record?.name).toLowerCase() !== name) throw new Error('THORName was not found.');
  if (String(record?.owner).toLowerCase() !== address) throw new Error('The THORName must be owned by this bond provider.');
  const height = Math.max(0, ...(Array.isArray(blocks) ? blocks : []).map((item) => Number(item.thorchain) || 0));
  const expiry = Number(record.expire_block_height);
  if (!Number.isSafeInteger(height) || height <= 0 || !Number.isSafeInteger(expiry) || expiry <= 0) throw new Error('Unable to verify THORName expiry.');
  if (expiry < height) throw new Error('This THORName has expired. Renew it before configuring payouts.');
  return { ...record, name };
}

export function connectedBondYieldOwner(accounts, owner) {
  const address = String(owner || '').toLowerCase();
  return (accounts || []).some((account) => account.network === 'THOR' && String(account.address).toLowerCase() === address) ? address : '';
}

/** Discover by ownership, not alias association; THORNode remains authoritative. */
export async function loadOwnedBondYieldNames(midgard, thornode, owner, { fresh = false } = {}) {
  const address = requireBondYieldAddress(owner, 'Bond provider');
  let candidates;
  try {
    candidates = await midgard.fetch(`/thorname/owner/${address}`, { cache: !fresh });
  } catch (error) {
    // Midgard's owner endpoint uses 404 for an address with no indexed names.
    if (error.status === 404) return { names: [], unavailableCount: 0 };
    throw error;
  }
  if (!Array.isArray(candidates) || candidates.some((name) => typeof name !== 'string')) throw new Error('Unable to read the THORName owner list.');
  const names = [...new Set(candidates.map((value) => {
    const name = bondYieldTarget(value);
    if (!name || name.startsWith('thor1') && name.length > 30) throw new Error('Invalid name in the THORName owner list.');
    return name;
  }))].sort();
  if (!names.length) return { names: [], unavailableCount: 0 };
  const options = { cache: false, coreSnapshot: false };
  const blocks = await thornode.fetch('/thorchain/lastblock', options);
  const height = Math.max(0, ...(Array.isArray(blocks) ? blocks : []).map((item) => Number(item.thorchain) || 0));
  if (!Number.isSafeInteger(height) || height <= 0) throw new Error('Unable to verify THORName expiry.');
  const found = [];
  let index = 0;
  let unavailableCount = 0;
  // Bound fresh name lookups; no per-pool or global name scan is needed.
  await Promise.all(Array.from({ length: Math.min(4, names.length) }, async () => {
    while (index < names.length) {
      const name = names[index++];
      try {
        const record = await thornode.fetch(`/thorchain/thorname/${encodeURIComponent(name)}`, options);
        const expiry = Number(record?.expire_block_height);
        if (String(record?.name).toLowerCase() !== name || !Number.isSafeInteger(expiry) || expiry <= 0 || !record?.owner) throw new Error('Incomplete THORName record.');
        if (String(record.owner).toLowerCase() !== address || expiry < height) continue;
        found.push({ ...record, name });
      } catch (error) {
        if (error.status !== 404) unavailableCount++;
      }
    }
  }));
  return { names: found.sort((a, b) => a.name.localeCompare(b.name)), unavailableCount };
}

/** A late response for a disconnected/replaced wallet must not repopulate choices. */
export function createBondYieldNameLookup(midgard, thornode, publish) {
  let activeOwner = '';
  let generation = 0;
  return {
    async setOwner(value, { refresh = false } = {}) {
      const owner = String(value || '').toLowerCase();
      if (owner === activeOwner && !refresh) return;
      activeOwner = owner;
      const request = ++generation;
      const empty = { owner, names: [], unavailableCount: 0, loading: false, error: '' };
      publish({ ...empty, loading: !!owner });
      if (!owner) return;
      try {
        const result = await loadOwnedBondYieldNames(midgard, thornode, owner, { fresh: refresh });
        if (request === generation) publish({ ...empty, ...result });
      } catch {
        if (request === generation) publish({ ...empty, error: 'Could not load your THORNames. Retry or enter one manually.' });
      }
    },
    dispose() { generation++; }
  };
}

/** Selecting a name fills its saved currency/address; it never approves a transaction. */
export function bondYieldNameFields(record, availableAssets = []) {
  const asset = String(record?.preferred_asset || '').toUpperCase();
  const native = !asset || asset === '.' || asset === 'THOR.RUNE';
  const payoutAsset = native ? 'THOR.RUNE' : availableAssets.includes(asset) ? asset : '';
  const payoutAddress = payoutAsset ? String(record.aliases?.find((alias) => String(alias.chain).toUpperCase() === payoutAsset.split('.')[0])?.address || (native ? record.owner : '') || '') : '';
  return { payoutTarget: bondYieldTarget(record?.name), payoutAsset, payoutAddress };
}
