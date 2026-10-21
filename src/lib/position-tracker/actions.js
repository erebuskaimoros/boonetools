/**
 * Hands reviewed Position Tracker plans (see memos.js) to the connected
 * wallet. The wallet extension or device prompts the user to sign; nothing
 * here holds keys or signs on its own.
 */

import { AssetValue, FeeOption } from '@tcswap/core';
import { connectWallet, getUSwap, withActiveProvider } from '../limit-orders/wallet.js';

export { pickSigner } from './actions-signer.js';

async function ensureConnected(signer) {
  const uSwap = getUSwap();
  if (uSwap.getWallet(signer.provider, signer.network)) return;
  if (signer.provider === 'KEYSTORE') {
    throw new Error('Keystore session expired. Reconnect the keystore wallet and try again.');
  }
  const accounts = await connectWallet(signer.provider, [signer.network]);
  if (!accounts.length) throw new Error(`Could not reconnect ${signer.provider} on ${signer.network}`);
}

async function assetValueFor(asset, amount) {
  const value = await AssetValue.from({ asset, asyncTokenLookup: true, value: String(amount) });
  if (!value) throw new Error(`Unsupported asset ${asset}`);
  return value;
}

/**
 * Execute a plan with the given signer ({ address, network, provider }).
 * Returns the broadcast transaction hash.
 *
 * @param {any} plan
 * @param {{ address: string, network: string, provider: string } | null} signer
 * @param {{ onStatus?: (note: string) => void }} [options]
 */
export async function executePlan(plan, signer, { onStatus = () => {} } = {}) {
  if (!signer) throw new Error(`Connect a wallet with a ${plan.chain} account first`);
  await ensureConnected(signer);
  const uSwap = getUSwap();

  return withActiveProvider(signer.provider, async () => {
    switch (plan.route) {
      case 'thor-deposit': {
        const assetValue = await assetValueFor(plan.asset, plan.amount);
        onStatus('Waiting for wallet signature…');
        return uSwap.thorchain.deposit({ assetValue, memo: plan.memo, recipient: '', feeOptionKey: FeeOption.Fast });
      }
      case 'inbound': {
        const assetValue = await assetValueFor(plan.asset, plan.amount);
        const approved = await uSwap.thorchain.isAssetValueApproved({ assetValue });
        if (!approved) {
          onStatus('Approve the token spend in your wallet…');
          await uSwap.thorchain.approveAssetValue({ assetValue });
        }
        onStatus('Waiting for wallet signature…');
        return uSwap.thorchain.depositToPool({ assetValue, memo: plan.memo, feeOptionKey: FeeOption.Fast });
      }
      case 'thor-send': {
        const assetValue = await assetValueFor(plan.asset, plan.amount);
        onStatus('Waiting for wallet signature…');
        return uSwap.transfer({ assetValue, recipient: plan.recipient, memo: plan.memo, feeOptionKey: FeeOption.Fast });
      }
      case 'inbound-dust': {
        onStatus('Waiting for wallet signature…');
        if (plan.action === 'tcy-claim') {
          const thorAddress = plan.memo.split(':')[1];
          return uSwap.thorchain.claimTcy({ chain: plan.chain, thorAddress });
        }
        const assetValue = await assetValueFor(plan.asset, '0');
        return uSwap.thorchain.withdraw({ assetValue, memo: plan.memo, percent: 100, from: 'asset', to: 'asset' });
      }
      default:
        throw new Error(`Unknown route ${plan.route}`);
    }
  });
}
