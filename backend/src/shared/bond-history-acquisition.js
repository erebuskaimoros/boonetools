import { fetchThorchain } from './thornode.js';
import { calculateBondHistoryRow, hasBondHistoryValue } from './bond-history.js';
import { acquisitionSourceKey, acquireCached, loadAcquisition, saveAcquisition } from './acquisition-cache.js';

function unsigned(value) { return /^\d+$/.test(String(value ?? '')); }

function validNode(payload, address) {
  return payload?.node_address === address && unsigned(payload?.current_award)
    && unsigned(payload?.bond_providers?.node_operator_fee)
    && Array.isArray(payload?.bond_providers?.providers)
    && payload.bond_providers.providers.every((provider) => typeof provider?.bond_address === 'string' && unsigned(provider?.bond));
}

export async function fetchNodeAtHeight(nodeAddress, height, options = {}) {
  if (!Number.isSafeInteger(Number(height)) || Number(height) <= 0) throw new Error('Invalid historical node height');
  const result = await (options.acquireCached || acquireCached)(options.client, {
    namespace: 'thorchain-mainnet:historical-node:v1', identity: { address: nodeAddress, height: Number(height) },
    source: 'thornode:node', immutable: true,
    validate: (payload) => validNode(payload, nodeAddress),
    load: (client) => (options.fetchThorchain || fetchThorchain)(`/thorchain/node/${nodeAddress}?height=${height}`, {
      historical: true, cooldownClient: client, sharedCooldown: true,
      validateResponse: (payload) => validNode(payload, nodeAddress) ? null : 'Invalid historical node response'
    })
  });
  return result.payload;
}

export async function fetchNetworkAtHeight(height, options = {}) {
  if (!Number.isSafeInteger(Number(height)) || Number(height) <= 0) throw new Error('Invalid historical network height');
  const valid = (payload) => unsigned(payload?.rune_price_in_tor);
  const result = await (options.acquireCached || acquireCached)(options.client, {
    namespace: 'thorchain-mainnet:historical-network:v1', identity: String(height),
    source: 'thornode:network', immutable: true, validate: valid,
    load: (client) => (options.fetchThorchain || fetchThorchain)(`/thorchain/network?height=${height}`, {
      historical: true, cooldownClient: client, sharedCooldown: true,
      validateResponse: (payload) => valid(payload) ? null : 'Invalid historical network response'
    })
  });
  return result.payload;
}

export async function processChurn(bondAddress, nodeAddresses, churnHeight, churnTimestamp, ratesJson, options = {}) {
  const namespace = 'bond-history:empty-churn:v1';
  const identity = acquisitionSourceKey({ bondAddress, nodes: [...new Set(nodeAddresses)].sort(), churnHeight });
  const empty = await (options.loadAcquisition || loadAcquisition)(options.client, namespace, identity, { requireComplete: true });
  if (empty?.completedAt && empty?.payload?.churn_height === churnHeight && !hasBondHistoryValue(empty.payload)) {
    return { ...empty.payload, rates_json: ratesJson };
  }
  const nodePromises = nodeAddresses.map(async (address) => {
    try {
      return {
        ok: true,
        data: await fetchNodeAtHeight(address, churnHeight - 1, options)
      };
    } catch (fetchError) {
      return {
        ok: false,
        data: null,
        error: fetchError
      };
    }
  });
  const networkPromise = fetchNetworkAtHeight(churnHeight, options)
    .then((data) => ({ ok: true, data }))
    .catch((fetchError) => ({
      ok: false,
      data: null,
      error: fetchError
    }));

  const [nodeResults, networkData] = await Promise.all([
    Promise.all(nodePromises),
    networkPromise
  ]);

  // A failed source is not evidence of a zero bond, regardless of HTTP status.
  if (nodeResults.some((result) => !result.ok) || !networkData.ok || !networkData.data) {
    return null;
  }

  const row = calculateBondHistoryRow({
    bondAddress,
    nodePayloads: nodeResults.map((result) => result?.data).filter(Boolean),
    networkData: networkData.data,
    churnHeight,
    churnTimestamp,
    ratesJson
  });
  if (!hasBondHistoryValue(row)) {
    await (options.saveAcquisition || saveAcquisition)(options.client, {
      namespace, identity, payload: { ...row, rates_json: null },
      source: 'thornode:verified-empty-churn', completedAt: new Date().toISOString()
    });
  }
  return row;
}

// A page budget is a work limit, not a statement that older actions do not exist.
export async function scanBondActionWindow(bondAddress, options = {}) {
  const { MIDGARD_BASES, fetchMidgard, fetchMidgardActions } = await import('./midgard.js');
  const base = options.base || MIDGARD_BASES[0];
  const sourceKey = options.sourceKey || acquisitionSourceKey(base);
  const providerOptions = { bases: [base], cooldownClient: options.client, sharedCooldown: true };
  let progress = options.progress;
  if (!(progress?.sourceKey === sourceKey && Number.isSafeInteger(progress.from)
    && Number.isSafeInteger(progress.until) && progress.until > progress.from
    && Number.isSafeInteger(progress.offset) && progress.offset >= 0)) {
    const health = await (options.fetchMidgard || fetchMidgard)('/health', providerOptions);
    const now = typeof options.healthNow === 'function' ? options.healthNow() : options.healthNow ?? Date.now();
    const nowMs = typeof now === 'number' ? now : Date.parse(now);
    const until = Math.floor(Number(health?.lastAggregated?.timestamp));
    if (health?.database !== true || health?.inSync !== true || !(Number(health?.lastAggregated?.height) > 0)
      || !Number.isSafeInteger(until) || until <= 0 || until * 1000 > nowMs) {
      throw new Error('Bond action aggregation watermark unavailable');
    }
    const from = options.coveredSourceKey === sourceKey && Number(options.coveredThrough) > 0
      ? Math.max(0, Math.floor(Number(options.coveredThrough)) - 1) : 0;
    if (until <= from) throw new Error('Bond action aggregation watermark has not advanced');
    progress = { sourceKey, from, until, offset: 0 };
  } else progress = { ...progress };
  const actions = [];
  const maxPages = Math.max(1, Math.trunc(options.maxPages || 20));
  for (let page = 0; page < maxPages; page++) {
    try {
      const data = await (options.fetchActions || fetchMidgardActions)({ address: bondAddress, type: 'bond',
        limit: 50, offset: progress.offset, fromTimestamp: progress.from, timestamp: progress.until }, providerOptions);
      if (!Array.isArray(data?.actions) || (options.validateAction && !data.actions.every(options.validateAction))) throw new Error('Malformed bond action page');
      actions.push(...data.actions);
      progress.offset += data.actions.length;
      if (data.actions.length < 50) return { actions, complete: true, sourceKey,
        coveredThrough: progress.until, progress: null, error: '' };
    } catch (error) {
      return { actions, complete: false, sourceKey, coveredThrough: null, progress, error: error?.message || String(error) };
    }
  }
  return { actions, complete: false, sourceKey, coveredThrough: null, progress,
    error: `Bond action scan reached ${maxPages} pages; continuing the same window next run` };
}
