import { fetchJson, firstProvider, getCoin, mapLimit, observed, rpcInteger, unavailable, units } from './common.js';

export const EVM_CHAINS = {
  ETH: { native: 'ETH.ETH', endpoints: ['https://ethereum-rpc.publicnode.com', 'https://eth-mainnet.public.blastapi.io'] },
  AVAX: { native: 'AVAX.AVAX', endpoints: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'] },
  BSC: { native: 'BSC.BNB', endpoints: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'] },
  BASE: { native: 'BASE.ETH', endpoints: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'] }
};
// Mainnet deployments: THORNode chain/evm/deployment/routerv6/Mainnet-RouterV61-Deployment.md.
// V6 vaultAllowance forwards to token.balanceOf(vault); V4 holds tokens in the router.
const ROUTER_CUSTODY = {
  '0x00dc6100103bc402d490aee3f9a5560cbd91f1d4': 'address',
  '0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146': 'router',
  '0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b': 'router'
};
const addressWord = address => {
  if (!/^0x[0-9a-f]{40}$/i.test(address)) throw new Error('Invalid EVM address');
  return address.slice(2).toLowerCase().padStart(64, '0');
};
const tokenContract = asset => /-0x[0-9a-f]{40}$/i.test(asset) ? asset.split('-')[1].toLowerCase() : null;
// ABI selectors: balanceOf(address), vaultAllowance(address,address), decimals().
const call = (to, data, block) => ({ method: 'eth_call', params: [{ to, data }, block] });

async function batch(requests, endpoints, options) {
  const results = new Map();
  // A partial JSON-RPC failure retries only failed IDs at the alternate provider.
  await mapLimit(Array.from({ length: Math.ceil(requests.length / 40) }, (_, i) => requests.slice(i * 40, (i + 1) * 40)), 2, async chunk => {
    let pending = chunk;
    for (const endpoint of endpoints) {
      if (!pending.length || options.signal?.aborted) break;
      try {
        const reply = await fetchJson(endpoint, pending, options);
        if (!Array.isArray(reply)) throw new Error('Invalid RPC batch response');
        for (const request of pending) {
          const entry = reply.find(x => x.id === request.id);
          try {
            if (entry?.error) throw new Error(entry.error.message || 'RPC error');
            rpcInteger(entry?.result);
            if (request.method === 'eth_call' && !/^0x[0-9a-f]{64}$/i.test(entry.result)) throw new Error('Invalid ABI balance result');
            results.set(request.id, { value: entry.result, provider: new URL(endpoint).host });
          } catch (error) { results.set(request.id, { error }); }
        }
      } catch (error) {
        for (const request of pending) results.set(request.id, { error });
      }
      pending = pending.filter(r => !results.get(r.id)?.value);
    }
    for (const request of pending) {
      if (!results.has(request.id)) results.set(request.id, { error: new Error('L1 check timed out') });
    }
  });
  return results;
}

export async function collectEvm(chain, vaults, pools, options) {
  const config = EVM_CHAINS[chain];
  const entries = vaults.flatMap(vault => {
    const address = vault.addresses?.find(a => a.chain === chain)?.address;
    return address ? [{ vault, address, router: vault.routers?.find(r => r.chain === chain)?.router }] : [];
  });
  if (!entries.length) return [];
  const tokenAssets = [...new Set([...pools, ...vaults.flatMap(v => v.coins)].map(c => c.asset).filter(a => a?.startsWith(`${chain}.`) && tokenContract(a)))];
  const targets = entries.flatMap(({ vault }) => [config.native, ...tokenAssets].map(asset => getCoin(vault, asset)));
  try {
    const block = await firstProvider(config.endpoints, async endpoint => {
      const reply = await fetchJson(endpoint, [{ jsonrpc: '2.0', id: 'block', method: 'eth_blockNumber', params: [] }], options);
      const entry = Array.isArray(reply) ? reply.find(item => item.id === 'block') : null;
      if (entry?.error) throw new Error(entry.error.message || 'Block lookup failed');
      const value = entry?.result;
      rpcInteger(value);
      return value;
    }, options);
    const requests = [];
    const add = (id, request) => { requests.push({ jsonrpc: '2.0', id, ...request }); return id; };
    const tokenMeta = new Map();
    for (const asset of tokenAssets) {
      const contract = tokenContract(asset);
      tokenMeta.set(asset, { contract, decimalsId: add(`decimals:${asset}`, call(contract, '0x313ce567', block)) });
    }
    const groups = new Map();
    const coinReads = [];
    for (const { vault, address, router } of entries) {
      addressWord(address);
      coinReads.push({ coin: getCoin(vault, config.native), id: add(`native:${vault.pub_key}`, { method: 'eth_getBalance', params: [address, block] }), decimals: 18 });
      for (const [asset, meta] of tokenMeta) {
        const custody = router ? ROUTER_CUSTODY[router.toLowerCase()] : null;
        if (!custody) {
          unavailable(getCoin(vault, asset), new Error(router ? 'Unrecognized router custody model' : 'Vault router metadata unavailable'));
          continue;
        }
        const heldInRouter = custody === 'router';
        const data = heldInRouter
          ? '0x03b6a673' + addressWord(address) + addressWord(meta.contract)
          : '0x70a08231' + addressWord(address);
        const id = add(`token:${vault.pub_key}:${asset}`, call(heldInRouter ? router : meta.contract, data, block));
        coinReads.push({ coin: getCoin(vault, asset), id, decimalsId: meta.decimalsId, scope: heldInRouter ? 'router_allowance' : 'address', router: heldInRouter ? router : null });
        if (heldInRouter) {
          const key = `${router.toLowerCase()}:${asset}`;
          if (!groups.has(key)) groups.set(key, { chain, asset, router, decimalsId: meta.decimalsId, allowanceIds: [], id: add(`backing:${key}`, call(meta.contract, '0x70a08231' + addressWord(router), block)) });
          groups.get(key).allowanceIds.push(id);
        }
      }
    }
    const results = await batch(requests, config.endpoints, options);
    const value = id => {
      const result = results.get(id);
      if (!result?.value) throw result?.error || new Error('Missing RPC response');
      return rpcInteger(result.value);
    };
    for (const read of coinReads) {
      try {
        const decimals = read.decimals ?? Number(value(read.decimalsId));
        observed(read.coin, units(value(read.id), decimals), results.get(read.id).provider, options, {
          balance_scope: read.scope || 'address', balance_block: rpcInteger(block).toString(), ...(read.router ? { balance_router: read.router } : {})
        });
      } catch (error) { unavailable(read.coin, error); }
    }
    return [...groups.values()].map(group => {
      const check = { chain, asset: group.asset, router: group.router, block: rpcInteger(block).toString(), observed_at: new Date(options.now ?? Date.now()).toISOString() };
      try {
        const decimals = Number(value(group.decimalsId));
        const actual = value(group.id);
        const allowance = group.allowanceIds.reduce((sum, id) => sum + value(id), 0n);
        return { ...check, status: actual < allowance ? 'shortfall' : 'covered', actual_amount: units(actual, decimals), allowance_amount: units(allowance, decimals), provider: results.get(group.id).provider };
      } catch (error) { return { ...check, status: 'unavailable', error: error.message }; }
    });
  } catch (error) {
    for (const coin of targets) unavailable(coin, error);
    return [];
  }
}
