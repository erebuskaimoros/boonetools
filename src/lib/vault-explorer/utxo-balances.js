const UTXO_CHAINS = {
  LTC: {
    asset: 'LTC.LTC',
    balanceSource: 'ltc_chain',
    endpoints: ['https://litecoinspace.org/api']
  }
};

function getVaultChainAddress(vault, chain) {
  return vault?.addresses?.find((entry) => entry.chain === chain)?.address || null;
}

function getExistingCoin(vault, asset) {
  return vault?.coins?.find((coin) => coin.asset === asset) || null;
}

function statBalance(stats = {}) {
  return BigInt(stats.funded_txo_sum || 0) - BigInt(stats.spent_txo_sum || 0);
}

function parseAddressBalance(payload) {
  const confirmed = statBalance(payload?.chain_stats);
  const mempool = statBalance(payload?.mempool_stats);
  const balance = confirmed + mempool;
  return balance > 0n ? balance.toString() : '0';
}

async function fetchAddressBalance(address, config) {
  let lastError = null;

  for (const endpoint of config.endpoints) {
    try {
      const response = await fetch(`${endpoint}/address/${address}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseAddressBalance(await response.json());
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('UTXO balance request failed');
}

function addOrUpdateCoin(coins, asset, baseAmount, metadata = {}) {
  const existingIndex = coins.findIndex((coin) => coin.asset === asset);
  const existing = existingIndex >= 0 ? coins[existingIndex] : null;
  const next = {
    ...(existing || { asset }),
    ...metadata,
    asset,
    amount: baseAmount
  };

  if (existingIndex >= 0) {
    coins[existingIndex] = next;
  } else if (BigInt(baseAmount) > 0n) {
    coins.push(next);
  }
}

export async function hydrateUtxoOnChainBalances(rawVaults, chains = ['LTC']) {
  const vaults = rawVaults.map((vault) => ({
    ...vault,
    addresses: [...(vault.addresses || [])],
    routers: [...(vault.routers || [])],
    coins: (vault.coins || []).map((coin) => ({ ...coin }))
  }));

  const requests = [];

  for (const vault of vaults) {
    for (const chain of chains) {
      const config = UTXO_CHAINS[chain];
      const address = config ? getVaultChainAddress(vault, chain) : null;
      if (!address) continue;

      requests.push(
        fetchAddressBalance(address, config).then((baseAmount) => ({
          vault,
          config,
          baseAmount
        }))
      );
    }
  }

  const results = await Promise.all(requests);

  for (const { vault, config, baseAmount } of results) {
    const existing = getExistingCoin(vault, config.asset);
    addOrUpdateCoin(vault.coins, config.asset, baseAmount, {
      balance_source: config.balanceSource,
      thornode_amount: existing?.amount || null
    });
  }

  return vaults;
}
