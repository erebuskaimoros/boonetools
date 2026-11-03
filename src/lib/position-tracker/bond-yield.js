/** Bond Yield configuration rules from THORNode v3.21.0 / ADR 029. */
import { bech32 } from '@scure/base';
import { isModuleAddress } from '../constants/addresses.js';
import { bondYieldAsset, bondYieldAssetAddress } from './bond-yield-assets.js';
export { bondYieldAssetOptions } from './bond-yield-assets.js';

export const BOND_YIELD_STATUSES = new Set(['Active', 'Standby', 'Ready']);

export function requireBondYieldAddress(value, label = 'Payout address') {
  const text = String(value ?? '').trim();
  try {
    const decoded = bech32.decodeToBytes(text);
    if (decoded.prefix !== 'thor' || decoded.bytes.length !== 20) throw new Error();
  } catch {
    throw new Error(`${label} must be a valid mainnet thor1 address`);
  }
  return text.toLowerCase();
}

export function bondYieldTarget(value) {
  const target = String(value ?? '').trim();
  if (!target) return '';
  if (/^thor1/i.test(target) && target.length > 30) {
    const address = requireBondYieldAddress(target);
    if (isModuleAddress(address)) throw new Error('Payout destination cannot be a network module.');
    return address;
  }
  if (!/^[a-zA-Z0-9+_-]{1,30}$/.test(target)) {
    throw new Error('Enter a valid thor1 address or a THORName (up to 30 letters, numbers, +, _ or -).');
  }
  return target.toLowerCase();
}

export function requireBondYieldName(value) {
  const name = bondYieldTarget(value);
  if (!name || name.startsWith('thor1') && name.length > 30) throw new Error('Choose or enter a provider-owned THORName.');
  return name;
}

/** Exact hundredths of a percent, including zero to disable payouts. */
export function bondYieldBps(percent) {
  const text = String(percent ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Payout percentage must be 0–100, with at most two decimals.');
  const [whole, fraction = ''] = text.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10000) throw new Error('Payout percentage must be 0–100.');
  return bps;
}

export function readBondYieldConfig(provider = {}) {
  const bps = Number(provider.bps ?? 0);
  return {
    bps: Number.isInteger(bps) && bps >= 0 && bps <= 10000 ? bps : null,
    target: String(provider.payout_target || '')
  };
}

function configValue(values, key) {
  const entry = Object.entries(values || {}).find(([name]) => name.toUpperCase() === key);
  if (!entry || entry[1] == null || entry[1] === '' || typeof entry[1] === 'boolean') return null;
  const value = Number(entry[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function payoutName(thorname, target, owner) {
  if (!thorname || String(thorname.name).toLowerCase() !== target) throw new Error('THORName was not found.');
  if (String(thorname.owner).toLowerCase() !== owner) throw new Error('The payout THORName must be owned by this bond provider.');
}

function preferredNameAsset(thorname) {
  const asset = String(thorname?.preferred_asset || '').toUpperCase();
  return !asset || asset === '.' || asset === 'THOR.RUNE' ? 'RUNE' : asset;
}

function payoutAlias(thorname, chain) {
  return String(thorname?.aliases?.find((item) => String(item.chain).toUpperCase() === chain)?.address || '');
}

/** @param {{ version?: any, mimir?: any, constants?: any }} [input] */
export function bondYieldGate({ version, mimir, constants } = {}) {
  const current = String(version?.current || '');
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const available = !!match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 21));
  let reason = '';
  if (!match) reason = 'Unable to verify the network version. Refresh before signing.';
  else if (!available) reason = `Requires THORChain 3.21 (network ${current}).`;
  else if (!mimir || typeof mimir !== 'object' || Array.isArray(mimir)) reason = 'Unable to verify network activation. Refresh before signing.';
  else {
    const override = configValue(mimir, 'BONDYIELDENABLED');
    const hasOverride = Object.keys(mimir).some((key) => key.toUpperCase() === 'BONDYIELDENABLED');
    const value = override != null && override >= 0 ? override : configValue(constants?.int_64_values, 'BONDYIELDENABLED');
    if ((hasOverride && override == null) || value == null) reason = 'Unable to verify network activation. Refresh before signing.';
    else if (value <= 0) reason = 'Bond yield payouts are not enabled on the network.';
  }
  return { bondYieldEnabled: !reason, bondYieldReason: reason, networkVersion: current };
}

/** Validate the exact provider and destination against fresh chain state. */
export function validateBondYieldReview({ node, owner, signer, gates, bps, target = '', thorname = null }) {
  if (!gates?.bondYieldEnabled) throw new Error(gates?.bondYieldReason || 'Unable to verify bond yield activation.');
  if (gates.globalHalt) throw new Error('THORChain is halted by mimir right now.');
  const providerAddress = requireBondYieldAddress(owner, 'Bond provider');
  if (String(signer || '').toLowerCase() !== providerAddress) throw new Error(`Connect the bond provider wallet …${providerAddress.slice(-4)}.`);
  if (!BOND_YIELD_STATUSES.has(node?.status)) throw new Error('Bond yield requires an Active, Standby or Ready node.');
  const provider = node.bond_providers?.providers?.find((item) => String(item.bond_address).toLowerCase() === providerAddress);
  if (!provider) throw new Error('This wallet is not a bond provider on this node.');
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new Error('Invalid payout basis points.');
  if (bps === 0) return { destination: '', asset: 'RUNE' };
  // An omitted non-zero target preserves the stored target on chain.
  const resolved = bondYieldTarget(target || provider.payout_target || providerAddress);
  if (resolved.startsWith('thor1') && resolved.length > 30) return { destination: resolved, asset: 'RUNE' };
  payoutName(thorname, resolved, providerAddress);
  const asset = preferredNameAsset(thorname);
  if (asset !== 'RUNE') {
    bondYieldAsset(asset);
    const chain = asset.split('.')[0];
    const destination = payoutAlias(thorname, chain);
    if (!destination) throw new Error(`This THORName needs a ${chain} receiving alias before payouts can be enabled.`);
    return { destination, asset, collector: true, thorname: resolved };
  }
  const alias = thorname.aliases?.find((item) => item.chain === 'THOR')?.address || providerAddress;
  const destination = requireBondYieldAddress(alias, 'THORName THOR alias');
  if (isModuleAddress(destination)) throw new Error('Payout destination cannot be a network module.');
  return { destination, asset: 'RUNE' };
}

/** Signing bypasses UI caches and dashboard snapshots; display gates may read the shared snapshot. */
export async function loadBondYieldGate(client, { fresh = true } = {}) {
  const options = fresh ? { cache: false, coreSnapshot: false } : {};
  const [version, mimir, constants] = await Promise.all([
    client.fetch('/thorchain/version', options).catch(() => null),
    client.fetch('/thorchain/mimir', options).catch(() => null),
    client.fetch('/thorchain/constants', options).catch(() => null)
  ]);
  return {
    ...bondYieldGate({ version, mimir, constants }),
    globalHalt: configValue(mimir, 'HALTCHAINGLOBAL') > 0 || configValue(mimir, 'HALTTHORCHAIN') > 0,
    mimir
  };
}

export async function loadBondYieldReview(client, { plan, owner, signer, preferredAsset = '', payoutAddress = '' }) {
  const gates = await loadBondYieldGate(client);
  if (!gates.bondYieldEnabled) throw new Error(gates.bondYieldReason);
  const options = { cache: false, coreSnapshot: false };
  const node = await client.fetch(`/thorchain/node/${requireBondYieldAddress(plan.nodeAddress, 'Node address')}`, options);
  if (node?.node_address !== plan.nodeAddress) throw new Error('Unable to verify the selected node.');
  const provider = node?.bond_providers?.providers?.find((item) => String(item.bond_address).toLowerCase() === String(owner).toLowerCase());
  const target = plan.bps === 0 ? '' : bondYieldTarget(plan.payoutTarget || provider?.payout_target || owner);
  const isName = target && !(target.startsWith('thor1') && target.length > 30);
  const thorname = isName ? await client.fetch(`/thorchain/thorname/${encodeURIComponent(target)}`, options) : null;
  const input = { node, owner, signer, gates, bps: plan.bps, target, thorname };
  if (plan.bps === 0) return validateBondYieldReview(input);
  if (preferredAsset && !isName) throw new Error('A payout in another asset requires a provider-owned THORName.');
  // Check provider authority before examining or planning any THORName changes.
  validateBondYieldReview({ ...input, target: owner });
  let height = 0;
  if (isName) {
    payoutName(thorname, target, requireBondYieldAddress(owner, 'Bond provider'));
    const blocks = await client.fetch('/thorchain/lastblock', options);
    height = Math.max(0, ...(Array.isArray(blocks) ? blocks : []).map((item) => Number(item.thorchain) || 0));
    const expiry = Number(thorname.expire_block_height);
    if (!Number.isSafeInteger(height) || height <= 0 || !Number.isSafeInteger(expiry) || expiry <= 0) throw new Error('Unable to verify the THORName expiry.');
    if (expiry < height) throw new Error('This THORName has expired. Renew it before configuring payouts.');
  }
  const asset = String(preferredAsset).trim().toUpperCase() === 'THOR.RUNE' ? 'RUNE'
    : preferredAsset ? bondYieldAsset(preferredAsset) : preferredNameAsset(thorname);
  if (asset === 'RUNE' && !preferredAsset) return validateBondYieldReview(input);
  const chain = asset === 'RUNE' ? 'THOR' : asset.split('.')[0];
  const rawAddress = preferredAsset ? payoutAddress : payoutAlias(thorname, chain);
  if (!rawAddress) throw new Error(`Enter the ${chain} receiving address for this THORName.`);
  const destination = asset === 'RUNE' ? requireBondYieldAddress(rawAddress, 'THORName THOR alias') : await bondYieldAssetAddress(asset, rawAddress);
  if (chain === 'THOR' && isModuleAddress(destination)) throw new Error('Payout destination cannot be a network module.');
  if (asset !== 'RUNE') {
    const pool = await client.fetch(`/thorchain/pool/${encodeURIComponent(asset)}`, options);
    if (String(pool?.asset).toUpperCase() !== asset || pool?.status !== 'Available') throw new Error('The payout asset must have an available THORChain pool.');
    const halted = (key) => {
      const value = configValue(gates.mimir, key);
      return value > 0 && value <= height;
    };
    if (['HALTTRADING', `HALT${chain}TRADING`, `HALT${chain}CHAIN`, `SOLVENCYHALT${chain}CHAIN`, ...(chain === 'THOR' ? [] : ['HALTSIGNING', `HALTSIGNING${chain}`])].some(halted)) {
      throw new Error(`${chain} payouts are currently halted. Check again when the route is available.`);
    }
    if (chain !== 'THOR') {
      const inbound = await client.fetch('/thorchain/inbound_addresses', options);
      const route = Array.isArray(inbound) && inbound.find((item) => item.chain === chain);
      if (!route) throw new Error(`Unable to verify the ${chain} payout route.`);
      if (route.halted || route.global_trading_paused || route.chain_trading_paused) throw new Error(`${chain} payouts are currently halted. Check again when the route is available.`);
    }
  }
  const result = asset === 'RUNE' ? { destination, asset } : { destination, asset, collector: true, thorname: target };
  if (!preferredAsset) return result;
  const currentAsset = preferredNameAsset(thorname);
  const currentPayoutDestination = currentAsset === 'RUNE'
    ? payoutAlias(thorname, 'THOR') || requireBondYieldAddress(owner)
    : payoutAlias(thorname, currentAsset.split('.')[0]);
  const currentDestination = payoutAlias(thorname, chain);
  const sameDestination = asset === 'RUNE' ? currentDestination || requireBondYieldAddress(owner)
    : currentDestination && await bondYieldAssetAddress(asset, currentDestination).catch(() => '');
  if (currentAsset === asset && sameDestination === destination) return result;
  if (configValue(gates.mimir, 'THORNAMES') === 0) throw new Error('THORName updates are currently disabled.');
  // Blank owner/expiry fields preserve ownership and registration duration. This
  // configures an existing name only; no registration payment is constructed.
  const memo = `~:${target}:${chain}:${destination}::${asset === 'RUNE' ? 'THOR.RUNE' : asset}`;
  if (new TextEncoder().encode(memo).length > 250) throw new Error('The THORName settings exceed the memo size limit.');
  return { ...result, currentAsset, currentDestination, currentPayoutDestination, setupPlan: {
    action: 'bond-yield-asset', title: `Set ${target} payouts to ${asset}`,
    chain: 'THOR', asset: 'THOR.RUNE', amount: '0', route: 'thor-deposit', memo
  } };
}

/** Recheck the reviewed transaction immediately before handing it to a wallet. */
export async function recheckBondYieldBeforeSigning(client, input, checked) {
  const current = await loadBondYieldReview(client, input);
  if (!checked || JSON.stringify(current) !== JSON.stringify(checked)) {
    throw new Error('The payout settings changed. Check the settings again before signing.');
  }
  return current;
}
