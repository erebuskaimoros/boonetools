const providers = new Map();
const caches = new Map();
const LIMIT = 32;

function bucket(map, key, initial) {
  const boundedKey = map.has(key) || map.size < LIMIT ? key : 'other';
  if (!map.has(boundedKey)) map.set(boundedKey, initial(boundedKey));
  return map.get(boundedKey);
}

export function providerMetricKey(value) {
  try {
    const url = new URL(value);
    // Keep endpoint families; omit credentials, query strings, addresses,
    // contract messages, symbols, and heights from operational counters.
    const parts = url.pathname.split('/').filter(Boolean).filter((part) => !/^api=/i.test(part));
    const known = new Set(['chain', 'thorchain_api', 'thorchain_rpc', 'thorchain_midgard', 'v1', 'v2', 'v3', 'v8',
      'thorchain', 'cosmos', 'cosmwasm', 'bank', 'wasm', 'smart', 'contract', 'query', 'tx', 'txs', 'actions',
      'history', 'earnings', 'rune', 'swaps', 'depths', 'pools', 'pool', 'node', 'nodes', 'network', 'mimir',
      'constants', 'lastblock', 'status', 'health', 'block', 'block_results', 'tx_search', 'balance', 'balances',
      'module', 'treasury', 'member', 'oracle', 'prices', 'liquidity_provider', 'tcy_staker', 'upgrade_proposals',
      'inbound_addresses', 'vaults', 'asgard', 'trade', 'units', 'securedassets', 'dynamic_l1_fees',
      'dynamic_l1_fees_current', 'api', 'execution', 'results', 'execute', 'finance', 'chart']);
    return `${url.hostname}/${parts.map((part) => known.has(part) ? part : ':id').join('/')}`.slice(0, 180);
  } catch { return 'unknown'; }
}

export function recordProviderMetric(url, outcome) {
  const row = bucket(providers, providerMetricKey(url), (endpoint) => ({ endpoint, attempts: 0, succeeded: 0, failed: 0, cooldown_skipped: 0 }));
  if (outcome === 'cooldown_skipped') row.cooldown_skipped += 1;
  else {
    row.attempts += 1;
    row[outcome === 'succeeded' ? 'succeeded' : 'failed'] += 1;
  }
}

export function recordAcquisitionMetric(namespace, outcome) {
  const row = bucket(caches, String(namespace).slice(0, 100), (namespace) => ({ namespace, hit: 0, miss: 0, coalesced: 0 }));
  if (Object.hasOwn(row, outcome)) row[outcome] += 1;
}

export function acquisitionMetrics({ reset = false } = {}) {
  if (!providers.size && !caches.size) return null;
  const result = { providers: [...providers.values()].map((row) => ({ ...row })), caches: [...caches.values()].map((row) => ({ ...row })) };
  if (reset) { providers.clear(); caches.clear(); }
  return result;
}
