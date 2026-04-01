import { config } from '../lib/config.js';

const THORNODE_PRIMARY = config.thornodePrimaryUrl;
const THORNODE_FALLBACK = config.thornodeFallbackUrl;
const MIDGARD_CHURNS = `${config.midgardUrl.replace(/\/$/, '')}/churns`;

let activeThornodeIndex = 0;

function isChallengeResponse(response) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const cfMitigated = response.headers.get('cf-mitigated');
  return contentType.includes('text/html') || Boolean(cfMitigated);
}

async function parseResponse(response, responseType) {
  if (responseType === 'text') {
    return response.text();
  }
  return response.json();
}

async function fetchFromBase(baseUrl, endpoint, responseType) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    headers: {
      Accept: responseType === 'text' ? 'text/plain' : 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${endpoint}`);
  }

  if (isChallengeResponse(response)) {
    throw new Error(`Challenge response for ${endpoint}`);
  }

  return parseResponse(response, responseType);
}

export async function fetchThorchain(endpoint, options = {}) {
  const responseType = options.responseType || 'json';

  try {
    const payload = await fetchFromBase(THORNODE_PRIMARY, endpoint, responseType);
    activeThornodeIndex = 0;
    return payload;
  } catch (primaryError) {
    if (options.historical) {
      throw primaryError;
    }

    const payload = await fetchFromBase(THORNODE_FALLBACK, endpoint, responseType);
    activeThornodeIndex = 1;
    return payload;
  }
}

export async function fetchNodes() {
  const payload = await fetchThorchain('/thorchain/nodes');
  if (!Array.isArray(payload)) {
    throw new Error('Invalid /thorchain/nodes response');
  }
  return payload;
}

export async function fetchHistoricalNodesAtHeight(height) {
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(`Invalid height: ${height}`);
  }

  const payload = await fetchThorchain(`/thorchain/nodes?height=${Math.trunc(height)}`, {
    historical: true
  });

  if (!Array.isArray(payload)) {
    throw new Error(`Invalid historical node response for height ${height}`);
  }

  return payload;
}

export async function fetchLastblock() {
  const payload = await fetchThorchain('/thorchain/lastblock');
  if (!Array.isArray(payload)) {
    throw new Error('Invalid /thorchain/lastblock response');
  }
  return payload;
}

export async function fetchChurns() {
  const response = await fetch(MIDGARD_CHURNS, {
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch churns (${response.status})`);
  }

  if (isChallengeResponse(response)) {
    throw new Error('Midgard returned challenge response');
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error('Invalid Midgard churn response');
  }

  return payload;
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
  THORNODE_PRIMARY,
  THORNODE_FALLBACK,
  MIDGARD_CHURNS
};
