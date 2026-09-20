import { calculateBondHistoryRow, hasBondHistoryValue } from './bond-history.js';
import { acquisitionSourceKey, acquireCached, loadAcquisition, saveAcquisition } from './acquisition-cache.js';
import {
  historicalBondHeight, fetchHistoricalBondNode, fetchHistoricalBondNetwork,
  validHistoricalNode, validHistoricalNetwork
} from './bond-history-rpc.js';

export async function fetchNodeAtHeight(nodeAddress, height, options = {}) {
  height = historicalBondHeight(height);
  const result = await (options.acquireCached || acquireCached)(options.client, {
    namespace: 'thorchain-mainnet:historical-node:v2', identity: { address: nodeAddress, height },
    source: 'thorchain-rpc:types.Query/Node', immutable: true,
    validate: (payload) => validHistoricalNode(payload, nodeAddress, height),
    load: (client) => fetchHistoricalBondNode(nodeAddress, height, { ...options, client })
  });
  return result.payload.data;
}

export async function fetchNetworkAtHeight(height, options = {}) {
  height = historicalBondHeight(height);
  const result = await (options.acquireCached || acquireCached)(options.client, {
    namespace: 'thorchain-mainnet:historical-network:v2', identity: String(height),
    source: 'thorchain-rpc:types.Query/Network', immutable: true,
    validate: (payload) => validHistoricalNetwork(payload, height),
    load: (client) => fetchHistoricalBondNetwork(height, { ...options, client })
  });
  return result.payload.data;
}

export async function processChurn(bondAddress, nodeAddresses, churnHeight, churnTimestamp, ratesJson, options = {}) {
  const namespace = 'bond-history:empty-churn:v2';
  const nodes = [...new Set(nodeAddresses)].sort();
  const identity = acquisitionSourceKey({ bondAddress, nodes, churnHeight });
  const empty = await (options.loadAcquisition || loadAcquisition)(options.client, namespace, identity, { requireComplete: true });
  const proof = empty?.payload;
  if (empty?.completedAt && proof?.node_height === churnHeight - 1 && proof.network_height === churnHeight
    && Array.isArray(proof.nodes) && JSON.stringify(proof.nodes) === JSON.stringify(nodes)
    && proof.row?.churn_height === churnHeight && proof.row.rune_stack === 0 && proof.row.user_bond === 0) {
    return { ...proof.row, rates_json: ratesJson };
  }
  const nodePromises = nodes.map(async (address) => {
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
      namespace, identity, payload: {
        row: { ...row, rates_json: null }, node_height: churnHeight - 1, network_height: churnHeight, nodes
      },
      source: 'thorchain-rpc:verified-empty-churn', completedAt: new Date().toISOString()
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
