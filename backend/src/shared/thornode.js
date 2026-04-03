import { config } from '../lib/config.js';
import { fetchMidgardChurns } from './midgard.js';

const THORNODE_PRIMARY = config.thornodePrimaryUrl;
const THORNODE_ARCHIVE = config.thornodeArchiveUrl;
const THORNODE_FALLBACK = config.thornodeFallbackUrl;

let activeThornodeIndex = 0;
const THORNODE_REQUEST_TIMEOUT_MS = 4000;

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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), THORNODE_REQUEST_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(`${baseUrl}${endpoint}`, {
      headers: {
        Accept: responseType === 'text' ? 'text/plain' : 'application/json'
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }

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
  const bases = options.historical
    ? [THORNODE_PRIMARY, THORNODE_ARCHIVE, THORNODE_FALLBACK]
    : (
        activeThornodeIndex === 1
          ? [THORNODE_FALLBACK, THORNODE_PRIMARY]
          : [THORNODE_PRIMARY, THORNODE_FALLBACK]
      );
  let lastError = null;

  for (let index = 0; index < bases.length; index += 1) {
    const base = bases[index];
    if (!base) {
      continue;
    }

    try {
      const payload = await fetchFromBase(base, endpoint, responseType);
      if (!options.historical) {
        activeThornodeIndex = base === THORNODE_FALLBACK ? 1 : 0;
      }
      return payload;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Unable to fetch ${endpoint}`);
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
