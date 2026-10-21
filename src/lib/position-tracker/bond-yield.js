/** Bond Yield configuration rules from THORNode v3.21.0 / ADR 029. */
import { bech32 } from '@scure/base';
import { isModuleAddress } from '../constants/addresses.js';

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
  if (!thorname || String(thorname.name).toLowerCase() !== resolved) throw new Error('THORName was not found.');
  if (String(thorname.owner).toLowerCase() !== providerAddress) throw new Error('The payout THORName must be owned by this bond provider.');
  if (thorname.preferred_asset && thorname.preferred_asset !== '.') {
    return { destination: resolved, asset: thorname.preferred_asset, collector: true };
  }
  const alias = thorname.aliases?.find((item) => item.chain === 'THOR')?.address || providerAddress;
  const destination = requireBondYieldAddress(alias, 'THORName THOR alias');
  if (isModuleAddress(destination)) throw new Error('Payout destination cannot be a network module.');
  return { destination, asset: 'RUNE' };
}

/** Bypass both UI caches and dashboard snapshots before a signing decision. */
export async function loadBondYieldGate(client) {
  const options = { cache: false, coreSnapshot: false };
  const [version, mimir, constants] = await Promise.all([
    client.fetch('/thorchain/version', options).catch(() => null),
    client.fetch('/thorchain/mimir', options).catch(() => null),
    client.fetch('/thorchain/constants', options).catch(() => null)
  ]);
  return {
    ...bondYieldGate({ version, mimir, constants }),
    globalHalt: configValue(mimir, 'HALTCHAINGLOBAL') > 0 || configValue(mimir, 'HALTTHORCHAIN') > 0
  };
}

export async function loadBondYieldReview(client, { plan, owner, signer }) {
  const gates = await loadBondYieldGate(client);
  if (!gates.bondYieldEnabled) throw new Error(gates.bondYieldReason);
  const options = { cache: false, coreSnapshot: false };
  const node = await client.fetch(`/thorchain/node/${requireBondYieldAddress(plan.nodeAddress, 'Node address')}`, options);
  if (node?.node_address !== plan.nodeAddress) throw new Error('Unable to verify the selected node.');
  const provider = node?.bond_providers?.providers?.find((item) => String(item.bond_address).toLowerCase() === String(owner).toLowerCase());
  const target = plan.bps === 0 ? '' : bondYieldTarget(plan.payoutTarget || provider?.payout_target || owner);
  const isName = target && !(target.startsWith('thor1') && target.length > 30);
  const thorname = isName ? await client.fetch(`/thorchain/thorname/${encodeURIComponent(target)}`, options) : null;
  return validateBondYieldReview({ node, owner, signer, gates, bps: plan.bps, target, thorname });
}
