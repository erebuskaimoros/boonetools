import { fetchThorchain } from './thornode.ts';
import {
  buildAssetUsdIndex,
  normalizeRapidSwapAction
} from '../../../src/lib/rapid-swaps/model.js';

const MIDGARD_BASES = [
  'https://midgard.thorchain.network/v2/actions',
  'https://midgard.liquify.com/v2/actions'
];
const ACTION_PAGE_LIMIT = 50;

let activeMidgardIndex = 0;

function isChallengeResponse(response: Response): boolean {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const cfMitigated = response.headers.get('cf-mitigated');
  return contentType.includes('text/html') || Boolean(cfMitigated);
}

async function fetchMidgardActionPage(nextPageToken = ''): Promise<{ actions: any[]; nextPageToken: string }> {
  const params = new URLSearchParams({
    type: 'swap',
    limit: String(ACTION_PAGE_LIMIT)
  });

  if (nextPageToken) {
    params.set('nextPageToken', nextPageToken);
  }

  let lastError: Error | null = null;

  for (let i = 0; i < MIDGARD_BASES.length; i++) {
    const idx = (activeMidgardIndex + i) % MIDGARD_BASES.length;
    const url = `${MIDGARD_BASES[idx]}?${params.toString()}`;

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'x-client-id': 'RuneTools'
        }
      });

      if (!response.ok) {
        lastError = new Error(`Failed to fetch Midgard actions (${response.status}) from ${MIDGARD_BASES[idx]}`);
        continue;
      }

      if (isChallengeResponse(response)) {
        lastError = new Error(`Midgard returned challenge response from ${MIDGARD_BASES[idx]}`);
        continue;
      }

      activeMidgardIndex = idx;
      const payload = await response.json();
      return {
        actions: Array.isArray(payload?.actions) ? payload.actions : [],
        nextPageToken: String(payload?.meta?.nextPageToken || '')
      };
    } catch (err) {
      lastError = err as Error;
    }
  }

  throw lastError || new Error('All Midgard endpoints failed');
}

export async function fetchRapidSwapRows(
  options: { maxPages?: number; knownTxIds?: Set<string> } = {}
): Promise<{ rows: Record<string, unknown>[]; scannedPages: number; scannedActions: number; observedAt: string; stoppedEarly: boolean }> {
  // When knownTxIds is provided, scan up to maxPages but stop early once
  // we hit a page where every detected rapid swap is already in the DB.
  const maxPages = Math.max(1, Math.trunc(options.maxPages || 200));
  const knownTxIds = options.knownTxIds || null;
  const observedAt = new Date().toISOString();

  const [network, pools] = await Promise.all([
    fetchThorchain('/thorchain/network'),
    fetchThorchain('/thorchain/pools')
  ]);

  const priceIndex = buildAssetUsdIndex(network, Array.isArray(pools) ? pools : []);
  const rowsByTxId = new Map<string, Record<string, unknown>>();

  let nextPageToken = '';
  let scannedPages = 0;
  let scannedActions = 0;
  let stoppedEarly = false;
  let consecutiveKnownPages = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const payload = await fetchMidgardActionPage(nextPageToken);
    const actions = payload.actions || [];

    scannedPages += 1;
    scannedActions += actions.length;

    let foundNewOnPage = false;

    for (const action of actions) {
      const row = normalizeRapidSwapAction(action, {
        observedAt,
        priceIndex
      });

      if (row?.tx_id) {
        const txId = String(row.tx_id);
        if (knownTxIds && !knownTxIds.has(txId)) {
          foundNewOnPage = true;
        }
        rowsByTxId.set(txId, row);
      }
    }

    // If we have known IDs to compare against, track consecutive pages
    // with no new rapid swaps. After 3 such pages, we've caught up.
    if (knownTxIds) {
      if (!foundNewOnPage) {
        consecutiveKnownPages++;
      } else {
        consecutiveKnownPages = 0;
      }

      if (consecutiveKnownPages >= 3) {
        stoppedEarly = true;
        break;
      }
    }

    if (!payload.nextPageToken) {
      break;
    }

    nextPageToken = payload.nextPageToken;
  }

  return {
    rows: [...rowsByTxId.values()],
    scannedPages,
    scannedActions,
    observedAt,
    stoppedEarly
  };
}
