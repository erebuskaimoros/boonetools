import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_PAGE_LIMIT,
  MIDGARD_BASES,
  fetchMidgardActions,
  fetchRapidSwapRows
} from '../src/lib/rapid-swaps/backend.js';

test('rapid swap backend keeps official Midgard first and avoids known bad fallback URL', () => {
  assert.equal(MIDGARD_BASES[0], 'https://midgard.thorchain.network/v2');
  assert.equal(MIDGARD_BASES.includes('https://midgard.liquify.com/v2'), false);
  assert.equal(MIDGARD_BASES.includes('https://gateway.liquify.com/chain/thorchain_midgard/v2'), true);
});

function buildRapidAction(txId, height) {
  return {
    status: 'success',
    height: String(height),
    date: new Date(`2026-04-01T00:00:${String(height % 60).padStart(2, '0')}Z`).toISOString(),
    in: [
      {
        txID: txId,
        address: 'thor1source',
        coins: [{ asset: 'BTC.BTC', amount: '100000000' }]
      }
    ],
    out: [
      {
        address: '0xdestination',
        coins: [{ asset: 'ETH.ETH', amount: '2000000000' }]
      }
    ],
    metadata: {
      swap: {
        memo: '=:ETH.ETH:0xdestination:0/0/4',
        liquidityFee: '1000',
        swapSlip: '20',
        streamingSwapMeta: {
          interval: '0',
          quantity: '4',
          count: '4',
          lastHeight: String(height + 1),
          inCoin: { asset: 'BTC.BTC', amount: '100000000' },
          outCoin: { asset: 'ETH.ETH', amount: '2000000000' }
        }
      }
    }
  };
}

test('fetchRapidSwapRows preserves a catch-up cursor when it stops after consecutive known pages', async () => {
  const originalFetch = global.fetch;
  const pages = new Map([
    ['', {
      actions: [buildRapidAction('tx-a', 10000), buildRapidAction('tx-b', 9999)],
      nextPageToken: 'cursor-2'
    }],
    ['cursor-2', {
      actions: [buildRapidAction('tx-c', 9990), buildRapidAction('tx-d', 9989)],
      nextPageToken: 'cursor-3'
    }],
    ['cursor-3', {
      actions: [buildRapidAction('tx-e', 9980), buildRapidAction('tx-f', 9979)],
      nextPageToken: 'cursor-4'
    }]
  ]);

  global.fetch = async (url) => {
    const parsedUrl = new URL(url);
    const token = parsedUrl.searchParams.get('nextPageToken') || '';
    const page = pages.get(token);
    assert.ok(page, `unexpected page token ${token}`);

    return new Response(JSON.stringify({
      actions: page.actions,
      meta: { nextPageToken: page.nextPageToken }
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json'
      }
    });
  };

  try {
    const result = await fetchRapidSwapRows({
      maxPages: 10,
      knownTxIds: new Set(['tx-a', 'tx-b', 'tx-c', 'tx-d', 'tx-e', 'tx-f']),
      stopBelowHeight: 9000,
      observedAt: '2026-04-02T12:00:00.000Z',
      priceIndex: { prices: new Map(), runePriceUsd: 0 }
    });

    assert.equal(result.stoppedEarly, true);
    assert.equal(result.reachedStopHeight, false);
    assert.equal(result.scannedPages, 3);
    assert.equal(result.nextPageToken, 'cursor-4');
    assert.equal(result.lowestHeight, 9979);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchMidgardActions falls back when a provider ignores nextPageToken paging', async () => {
  const originalFetch = global.fetch;
  const [primaryBase, ...fallbackBases] = MIDGARD_BASES;

  global.fetch = async (url) => {
    if (url === `${primaryBase}/actions?type=swap&limit=5&nextPageToken=cursor-2`) {
      return new Response(JSON.stringify({
        actions: new Array(ACTION_PAGE_LIMIT).fill(null).map((_, index) => buildRapidAction(`primary-${index}`, 20000 - index)),
        meta: {
          nextPageToken: 'cursor-2'
        }
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }

    if (fallbackBases.some((base) => url === `${base}/actions?type=swap&limit=5&nextPageToken=cursor-2`)) {
      return new Response(JSON.stringify({
        actions: [buildRapidAction('fallback-tx', 19900)],
        meta: {
          nextPageToken: 'cursor-3'
        }
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  try {
    const result = await fetchMidgardActions({
      limit: 5,
      nextPageToken: 'cursor-2'
    });

    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0]?.in?.[0]?.txID, 'fallback-tx');
    assert.equal(result.nextPageToken, 'cursor-3');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchMidgardActions falls back when a provider ignores txid filtering', async () => {
  const originalFetch = global.fetch;
  const [primaryBase, ...fallbackBases] = MIDGARD_BASES;

  global.fetch = async (url) => {
    if (url === `${primaryBase}/actions?type=swap&limit=5&txid=target-tx`) {
      return new Response(JSON.stringify({
        actions: [buildRapidAction('wrong-tx', 21000)],
        meta: {
          nextPageToken: ''
        }
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }

    if (fallbackBases.some((base) => url === `${base}/actions?type=swap&limit=5&txid=target-tx`)) {
      return new Response(JSON.stringify({
        actions: [buildRapidAction('target-tx', 20999)],
        meta: {
          nextPageToken: ''
        }
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  try {
    const result = await fetchMidgardActions({
      txId: 'target-tx',
      limit: 5
    });

    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0]?.in?.[0]?.txID, 'target-tx');
  } finally {
    global.fetch = originalFetch;
  }
});
