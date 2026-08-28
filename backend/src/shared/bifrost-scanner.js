import { config } from '../lib/config.js';
import { requestFromProviders } from '../lib/provider-client.js';
import { providerLifecycleHooks } from './provider-cooldown.js';

export const BIFROST_SCANNER_PROVIDER = 'vanaheimex';

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function scannerFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const scannerHeightDiff = nonNegativeNumber(value.scanner_height_diff);
  if (scannerHeightDiff === null) return null;

  const normalized = { scanner_height_diff: scannerHeightDiff };
  const chainHeight = nonNegativeNumber(value.chain_height);
  const blockScannerHeight = nonNegativeNumber(value.block_scanner_height);
  if (chainHeight !== null) normalized.chain_height = chainHeight;
  if (blockScannerHeight !== null) normalized.block_scanner_height = blockScannerHeight;
  if (typeof value.healthy === 'boolean') normalized.healthy = value.healthy;
  return normalized;
}

export function normalizeBifrostScannerInfo(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('Invalid Bifrost scanner response: expected a non-empty node array');
  }

  const byNodeAddress = new Map();
  for (const row of payload) {
    const nodeAddress = String(row?.node_address || '').trim();
    if (!nodeAddress || !row?.scanner || typeof row.scanner !== 'object' || Array.isArray(row.scanner)) {
      continue;
    }

    const existing = byNodeAddress.get(nodeAddress) || { node_address: nodeAddress, scanner: {} };
    for (const [key, value] of Object.entries(row.scanner)) {
      const chain = String(value?.chain || key || '').trim().toUpperCase();
      const fields = scannerFields(value);
      if (!chain || !fields) continue;
      existing.scanner[chain] = fields;
    }
    if (Object.keys(existing.scanner).length > 0) byNodeAddress.set(nodeAddress, existing);
  }

  const normalized = [...byNodeAddress.values()];
  if (normalized.length === 0) {
    throw new Error('Invalid Bifrost scanner response: no usable scanner-height records');
  }
  return normalized;
}

export function isBifrostScannerInfo(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((row) => (
    typeof row?.node_address === 'string'
    && row.node_address.length > 0
    && row.scanner
    && typeof row.scanner === 'object'
    && !Array.isArray(row.scanner)
    && Object.keys(row.scanner).length > 0
    && Object.values(row.scanner).every((scanner) => (
      nonNegativeNumber(scanner?.scanner_height_diff) !== null
    ))
  ));
}

function endpointParts(configuredUrl) {
  let endpoint;
  try {
    endpoint = new URL(configuredUrl);
  } catch {
    throw new Error(`Invalid Bifrost scanner URL: ${configuredUrl}`);
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error(`Invalid Bifrost scanner URL protocol: ${endpoint.protocol}`);
  }
  return {
    base: endpoint.origin,
    path: `${endpoint.pathname}${endpoint.search}`
  };
}

export async function fetchBifrostScannerInfo(options = {}) {
  const { base, path } = endpointParts(options.url || config.bifrostScannerInfoUrl);
  const raw = await requestFromProviders({
    bases: [base],
    path,
    timeoutMs: Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : config.bifrostScannerInfoTimeoutMs,
    fetchImpl: options.fetchImpl,
    headers: {
      Accept: 'application/json',
      'x-client-id': config.providerClientId
    },
    ...providerLifecycleHooks({
      client: options.cooldownClient,
      enabled: options.sharedCooldown
    }),
    validateResponse: (payload) => {
      try {
        normalizeBifrostScannerInfo(payload);
        return null;
      } catch (error) {
        return error;
      }
    },
    errorMessage: ({ status }) => `Bifrost scanner request failed (${status}) for ${path}`
  });
  return normalizeBifrostScannerInfo(raw);
}
