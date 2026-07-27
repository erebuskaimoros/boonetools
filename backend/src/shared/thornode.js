import { config } from '../lib/config.js';
import { requestFromProviders } from '../lib/provider-client.js';
import { fetchMidgardChurns } from './midgard.js';
import { providerLifecycleHooks } from './provider-cooldown.js';

const THORNODE_PRIMARY = config.thornodeUrls[0] || config.thornodePrimaryUrl;
const THORNODE_ARCHIVE = config.thornodeArchiveUrl;
const THORNODE_FALLBACK = config.thornodeUrls[1] || config.thornodeFallbackUrl;

const THORNODE_REQUEST_TIMEOUT_MS = 4000;

export async function fetchThorchain(endpoint, options = {}) {
  const responseType = options.responseType || 'json';
  const configuredBases = options.historical
    ? [config.thornodeUrls[0], THORNODE_ARCHIVE, ...config.thornodeUrls.slice(1)]
    : config.thornodeUrls;
  const bases = [...new Set(configuredBases.filter(Boolean))];
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : THORNODE_REQUEST_TIMEOUT_MS;
  return requestFromProviders({
    bases,
    path: endpoint,
    responseType,
    timeoutMs,
    headers: {
      Accept: responseType === 'text' ? 'text/plain' : 'application/json',
      'x-client-id': config.providerClientId,
      ...(options.headers || {})
    },
    ...providerLifecycleHooks({
      client: options.cooldownClient,
      enabled: options.sharedCooldown
    }),
    validateResponse: options.validateResponse,
    shouldStop: options.shouldStop,
    errorMessage: ({ status }) => `Request failed (${status}) for ${endpoint}`
  });
}

export async function fetchNodes() {
  return fetchThorchain('/thorchain/nodes', {
    validateResponse: (payload) => Array.isArray(payload)
      ? null
      : 'Invalid /thorchain/nodes response'
  });
}

export async function fetchHistoricalNodesAtHeight(height) {
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(`Invalid height: ${height}`);
  }

  const payload = await fetchThorchain(`/thorchain/nodes?height=${Math.trunc(height)}`, {
    historical: true,
    validateResponse: (response) => Array.isArray(response)
      ? null
      : `Invalid historical node response for height ${height}`
  });
  return payload;
}

export async function fetchLastblock() {
  return fetchThorchain('/thorchain/lastblock', {
    validateResponse: (payload) => Array.isArray(payload)
      ? null
      : 'Invalid /thorchain/lastblock response'
  });
}

export async function fetchChurns() {
  return fetchMidgardChurns();
}

export function extractThorHeight(lastblockRows) {
  if (!Array.isArray(lastblockRows)) {
    return 0;
  }

  const thorRow = lastblockRows.find((row) => (row?.chain || '').toUpperCase() === 'THOR');
  if (thorRow?.thorchain && Number.isFinite(Number(thorRow.thorchain))) {
    return Number(thorRow.thorchain);
  }

  let maxThorchain = 0;
  for (const row of lastblockRows) {
    const height = Number(row?.thorchain);
    if (Number.isFinite(height) && height > maxThorchain) {
      maxThorchain = height;
    }
  }

  if (maxThorchain > 0) {
    return maxThorchain;
  }

  return Number(lastblockRows[0]?.thorchain || 0);
}

export function computeMajorityVersion(nodes) {
  const activeNodes = (nodes || []).filter((node) => node?.status === 'Active' && node?.version);
  if (activeNodes.length === 0) {
    return '';
  }

  const counts = new Map();
  for (const node of activeNodes) {
    const version = String(node.version);
    counts.set(version, (counts.get(version) || 0) + 1);
  }

  let majority = '';
  let majorityCount = 0;

  for (const [version, count] of counts.entries()) {
    if (count > majorityCount) {
      majority = version;
      majorityCount = count;
    }
  }

  return majority;
}

function buildNetworkMaxByChain(nodes) {
  const activeNodes = (nodes || []).filter((node) => node?.status === 'Active');
  const maxByChain = new Map();

  for (const node of activeNodes) {
    for (const chain of node?.observe_chains || []) {
      const chainName = String(chain?.chain || '');
      if (!chainName) {
        continue;
      }

      const height = Number(chain?.height) || 0;
      const previous = maxByChain.get(chainName) || 0;
      if (height > previous) {
        maxByChain.set(chainName, height);
      }
    }
  }

  return maxByChain;
}

export function buildChainSyncRows(node, allNodes) {
  if (!node || !Array.isArray(node.observe_chains)) {
    return [];
  }

  const maxByChain = buildNetworkMaxByChain(allNodes);

  return (node.observe_chains || [])
    .map((chain) => {
      const chainName = String(chain?.chain || '');
      const nodeHeight = Number(chain?.height) || 0;
      const networkMax = maxByChain.get(chainName) || nodeHeight;

      return {
        chain: chainName,
        node_height: nodeHeight,
        network_max: networkMax,
        lag: Math.max(0, networkMax - nodeHeight)
      };
    })
    .sort((left, right) => right.lag - left.lag);
}

export {
  THORNODE_ARCHIVE,
  THORNODE_PRIMARY,
  THORNODE_FALLBACK
};
