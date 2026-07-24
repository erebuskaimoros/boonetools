import {
  actionMatchesPair,
  actionOverlapsRange,
  calculatePairLegTotals,
  extractSwapEvents,
  normalizeEpochTransactions
} from '../../../shared/dynamic-fees/transactions.js';
import { fetchMidgardActions } from './midgard.js';
import { fetchThorchainRpc } from './rpc.js';

const PAGE_LIMIT = 50;
const MAX_PAGES = 500;
const BLOCK_FETCH_CONCURRENCY = 8;
const MAX_BLOCKS_PER_REQUEST = 2500;

function actionTxId(action) {
  return String(action?.in?.[0]?.txID || action?.txID || '').trim().toUpperCase();
}

function actionEndHeight(action) {
  const startHeight = Math.max(0, Math.trunc(Number(action?.height) || 0));
  const lastHeight = Math.max(
    0,
    Math.trunc(Number(action?.metadata?.swap?.streamingSwapMeta?.lastHeight) || 0)
  );
  return Math.max(startHeight, lastHeight);
}

async function runConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }
  );

  await Promise.all(workers);
  return results;
}

export async function fetchDynamicFeeActions({
  affiliate,
  asset,
  fromHeight,
  toHeight = Number.MAX_SAFE_INTEGER,
  fetchActions = fetchMidgardActions
}) {
  const actions = [];
  const seenPageTokens = new Set();
  const seenActions = new Set();
  let prevPageToken = '';

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await fetchActions({
      type: 'swap',
      affiliate,
      asset,
      limit: String(PAGE_LIMIT),
      ...(prevPageToken
        ? { prevPageToken }
        : { fromHeight: String(fromHeight) })
    });
    const pageActions = Array.isArray(payload?.actions) ? payload.actions : [];
    let reachedUpperBound = false;
    for (const action of pageActions) {
      const height = Math.max(0, Math.trunc(Number(action?.height) || 0));
      if (height > toHeight) {
        reachedUpperBound = true;
        continue;
      }
      if (height < fromHeight) continue;
      const identity = [
        actionTxId(action),
        action?.date || '',
        action?.height || ''
      ].join(':');
      if (seenActions.has(identity)) continue;
      seenActions.add(identity);
      actions.push(action);
    }
    if (reachedUpperBound || pageActions.length === 0) return actions;

    prevPageToken = String(payload?.meta?.prevPageToken || '');
    if (!prevPageToken) return actions;
    if (seenPageTokens.has(prevPageToken)) {
      throw new Error('Midgard repeated a transaction page token');
    }
    seenPageTokens.add(prevPageToken);
  }

  throw new Error('Transaction result exceeded the safe pagination limit');
}

export function getDynamicFeeEventHeights(actions, pair, range) {
  const heights = new Set();

  for (const action of Array.isArray(actions) ? actions : []) {
    if (!actionOverlapsRange(action, range) || !actionMatchesPair(action, pair)) continue;
    const startHeight = Math.max(range.startHeight, Math.trunc(Number(action?.height) || 0));
    const endHeight = Math.min(range.endHeight, actionEndHeight(action));
    for (let height = startHeight; height <= endHeight; height += 1) {
      heights.add(height);
      if (heights.size > MAX_BLOCKS_PER_REQUEST) {
        throw new Error(`Selected transactions span more than ${MAX_BLOCKS_PER_REQUEST} blocks`);
      }
    }
  }

  return [...heights].sort((left, right) => left - right);
}

export async function buildDynamicFeeEpochTransactions({
  actions,
  pair,
  range,
  fetchBlockResults = (height) => fetchThorchainRpc('/block_results', { height })
}) {
  const matchingActions = (Array.isArray(actions) ? actions : [])
    .filter((action) => actionOverlapsRange(action, range) && actionMatchesPair(action, pair));
  const heights = getDynamicFeeEventHeights(matchingActions, pair, range);
  const blockResults = await runConcurrent(
    heights,
    BLOCK_FETCH_CONCURRENCY,
    (height) => fetchBlockResults(height)
  );
  const swapEvents = blockResults.flatMap(extractSwapEvents);
  const pairLegTotalsByTxId = {};

  for (const action of matchingActions) {
    const txId = actionTxId(action);
    if (!txId || pairLegTotalsByTxId[txId]) continue;
    const totals = calculatePairLegTotals(swapEvents, {
      pair,
      txId,
      memo: action?.metadata?.swap?.memo
    });
    if (totals.eventCount > 0) pairLegTotalsByTxId[txId] = totals;
  }

  return {
    transactions: normalizeEpochTransactions(matchingActions, {
      pair,
      range,
      pairLegTotalsByTxId
    }),
    scanned_block_count: heights.length,
    matched_swap_event_count: Object.values(pairLegTotalsByTxId)
      .reduce((sum, totals) => sum + Number(totals.eventCount || 0), 0)
  };
}

export async function getDynamicFeeEpochTransactions({
  affiliate,
  asset,
  pair,
  range,
  epochBlocks,
  fetchActions,
  fetchBlockResults
}) {
  const actions = await fetchDynamicFeeActions({
    affiliate,
    asset,
    fromHeight: Math.max(1, range.startHeight - epochBlocks),
    toHeight: range.endHeight,
    fetchActions
  });
  return buildDynamicFeeEpochTransactions({
    actions,
    pair,
    range,
    fetchBlockResults
  });
}
