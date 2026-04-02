import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchRapidSwapRows } from '../src/lib/rapid-swaps/backend.js';

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
