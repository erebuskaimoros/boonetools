import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_PAGE_LIMIT,
  MIDGARD_BASES,
  THORNODE_BASES,
  classifyRapidSwapSourceStatus,
  configureRapidSwapProviderLifecycle,
  fetchMidgardActions,
  fetchRapidSwapRows,
  getRapidSwapRateLimitCooldownMs,
  isRapidSwapRateLimitError,
  resolveRapidSwapHint
} from '../src/lib/rapid-swaps/backend.js';

const TEST_MIDGARD_BASES = [
  MIDGARD_BASES[0],
  'https://midgard-fallback.example/v2'
];

test('rapid swap backend uses only Liquify Midgard by default', () => {
  assert.deepEqual(MIDGARD_BASES, ['https://gateway.liquify.com/chain/thorchain_midgard/v2']);
});

test('rapid swap backend uses only Liquify THORNode by default', () => {
  assert.deepEqual(THORNODE_BASES, ['https://gateway.liquify.com/chain/thorchain_api']);
});

test('rapid swap backend recognizes provider rate limits and daily cooldowns', () => {
  const error = {
    status: 429,
    retryAfterSeconds: 60,
    body: 'Slow down you have hit your daily request limit'
  };

  assert.equal(isRapidSwapRateLimitError(error), true);
  assert.equal(getRapidSwapRateLimitCooldownMs(error, 60 * 60 * 1000), 60 * 60 * 1000);
});

test('rapid swap lifecycle skips a cooling provider and continues to fallback', async () => {
  const originalFetch = global.fetch;
  const urls = [];
  configureRapidSwapProviderLifecycle({
    beforeRequest: ({ base }) => {
      if (base === MIDGARD_BASES[0]) {
        const error = new Error('primary provider is cooling down after a rate limit');
        error.skipProvider = true;
        throw error;
      }
    }
  });
  global.fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ actions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    await fetchMidgardActions({ limit: 1, bases: TEST_MIDGARD_BASES });
    assert.deepEqual(urls, [`${TEST_MIDGARD_BASES[1]}/actions?type=swap&limit=1&offset=0`]);
  } finally {
    configureRapidSwapProviderLifecycle();
    global.fetch = originalFetch;
  }
});

test('classifyRapidSwapSourceStatus reports halted idle when trading and signing are paused', () => {
  const status = classifyRapidSwapSourceStatus({
    observedAt: '2026-05-25T13:00:00.000Z',
    mimir: {
      HALTTRADING: 1,
      HALTSIGNING: 1,
      HALTBTCCHAIN: 0,
      HALTBTCTRADING: 1
    },
    inboundAddresses: [
      {
        chain: 'BTC',
        halted: true,
        global_trading_paused: true,
        chain_trading_paused: true
      }
    ],
    lastblock: [
      {
        chain: 'BTC',
        thorchain: 26326177,
        last_signed_out: 26183225
      }
    ],
    latestSwapAction: buildRapidAction('latest-tx', 26183228)
  });

  assert.equal(status.status, 'halted_idle');
  assert.equal(status.trading_halted, true);
  assert.equal(status.signing_halted, true);
  assert.equal(status.midgard.latest_swap_action.height, 26183228);
  assert.equal(status.lastblock.thorchain_height, 26326177);
});

test('classifyRapidSwapSourceStatus reports degraded when a source check fails without halt flags', () => {
  const status = classifyRapidSwapSourceStatus({
    observedAt: '2026-05-25T13:00:00.000Z',
    mimir: {},
    inboundAddresses: [],
    lastblock: [],
    latestSwapAction: null,
    errors: {
      midgard: 'HTTP 500'
    }
  });

  assert.equal(status.status, 'degraded');
  assert.equal(status.midgard.status, 'error');
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
  const [primaryBase, ...fallbackBases] = TEST_MIDGARD_BASES;

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
      nextPageToken: 'cursor-2',
      bases: TEST_MIDGARD_BASES
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
  const [primaryBase, ...fallbackBases] = TEST_MIDGARD_BASES;

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
      limit: 5,
      bases: TEST_MIDGARD_BASES
    });

    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0]?.in?.[0]?.txID, 'target-tx');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchMidgardActions can anchor scans before a timestamp without offset paging', async () => {
  const originalFetch = global.fetch;
  const [primaryBase] = MIDGARD_BASES;

  global.fetch = async (url) => {
    assert.equal(url, `${primaryBase}/actions?type=swap&limit=5&timestamp=1777852800`);
    return new Response(JSON.stringify({
      actions: [buildRapidAction('timestamp-tx', 21999)],
      meta: {
        nextPageToken: 'cursor-before-timestamp'
      }
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json'
      }
    });
  };

  try {
    const result = await fetchMidgardActions({
      timestamp: 1777852800,
      limit: 5
    });

    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0]?.in?.[0]?.txID, 'timestamp-tx');
    assert.equal(result.nextPageToken, 'cursor-before-timestamp');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchMidgardActions re-probes primary Midgard first after a fallback success', async () => {
  const originalFetch = global.fetch;
  const [primaryBase, ...fallbackBases] = TEST_MIDGARD_BASES;
  const urls = [];

  global.fetch = async (url) => {
    urls.push(url);

    if (url === `${primaryBase}/actions?type=swap&limit=5&txid=fallback-first`) {
      return new Response(JSON.stringify({
        actions: [buildRapidAction('wrong-tx', 22000)],
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

    if (fallbackBases.some((base) => url === `${base}/actions?type=swap&limit=5&txid=fallback-first`)) {
      return new Response(JSON.stringify({
        actions: [buildRapidAction('fallback-first', 21999)],
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

    if (url === `${primaryBase}/actions?type=swap&limit=5&txid=official-recovered`) {
      return new Response(JSON.stringify({
        actions: [buildRapidAction('official-recovered', 21998)],
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

    if (fallbackBases.some((base) => url === `${base}/actions?type=swap&limit=5&txid=official-recovered`)) {
      return new Response(JSON.stringify({
        error: 'Slow down you have hit your daily request limit',
        status: 429
      }), {
        status: 429,
        headers: {
          'content-type': 'application/json'
        }
      });
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  try {
    const fallbackResult = await fetchMidgardActions({
      txId: 'fallback-first',
      limit: 5,
      bases: TEST_MIDGARD_BASES
    });
    assert.equal(fallbackResult.actions[0]?.in?.[0]?.txID, 'fallback-first');

    const recoveredResult = await fetchMidgardActions({
      txId: 'official-recovered',
      limit: 5,
      bases: TEST_MIDGARD_BASES
    });
    assert.equal(recoveredResult.actions[0]?.in?.[0]?.txID, 'official-recovered');
    assert.deepEqual(urls, [
      `${primaryBase}/actions?type=swap&limit=5&txid=fallback-first`,
      `${fallbackBases[0]}/actions?type=swap&limit=5&txid=fallback-first`,
      `${primaryBase}/actions?type=swap&limit=5&txid=official-recovered`
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchMidgardActions stops on rate limits instead of probing every fallback', async () => {
  const originalFetch = global.fetch;
  const urls = [];

  global.fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({
      error: 'your rune pouch is empty',
      status: 429
    }), {
      status: 429,
      headers: {
        'content-type': 'application/json'
      }
    });
  };

  try {
    await assert.rejects(
      () => fetchMidgardActions({ limit: 1, offset: 0 }),
      /HTTP 429/
    );
    assert.equal(urls.length, 1);
    assert.match(urls[0], /\/actions\?type=swap&limit=1&offset=0$/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveRapidSwapHint resolves directly from thornode tx data without querying Midgard actions', async () => {
  const originalFetch = global.fetch;
  const requestedUrls = [];

  global.fetch = async (url) => {
    requestedUrls.push(url);

    if (url === 'https://gateway.liquify.com/chain/thorchain_api/thorchain/tx/target-tx') {
      return new Response(JSON.stringify({
        consensus_height: 100,
        observed_tx: {
          tx: {
            id: 'target-tx',
            from_address: 'bc1source',
            memo: '=:ETH.ETH:0xdestination:0/0/5',
            coins: [
              {
                asset: 'BTC.BTC',
                amount: '100000000'
              }
            ]
          }
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
    const result = await resolveRapidSwapHint({
      tx_id: 'target-tx',
      last_height: 104,
      deposit: '100000000 BTC.BTC',
      in: '95000000 BTC.BTC',
      out: '200000000 ETH.ETH',
      raw_hint: {
        interval: 0,
        quantity: 10,
        count: 10
      }
    }, {
      observedAt: '2026-04-02T12:00:00.000Z',
      priceIndex: {
        prices: new Map([
          ['BTC.BTC', 80000],
          ['ETH.ETH', 2000]
        ]),
        runePriceUsd: 0
      }
    });

    assert.equal(result.resolvedBy, 'thornode_tx');
    assert.equal(result.row?.tx_id, 'target-tx');
    assert.equal(result.row?.blocks_used, 5);
    assert.equal(result.row?.input_estimated_usd, 76000);
    assert.equal(result.row?.output_estimated_usd, 4000);
    assert.equal(requestedUrls.some((url) => url.includes('/actions?')), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveRapidSwapHint marks non-rapid listener candidates as terminal without Midgard retries', async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    if (url === 'https://gateway.liquify.com/chain/thorchain_api/thorchain/tx/not-rapid') {
      return new Response(JSON.stringify({
        consensus_height: 100,
        observed_tx: {
          tx: {
            id: 'not-rapid',
            from_address: 'thor1source',
            memo: '=:ETH.ETH:0xdestination:0/0/2',
            coins: [
              {
                asset: 'THOR.RUNE',
                amount: '100000000'
              }
            ]
          }
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
    const result = await resolveRapidSwapHint({
      tx_id: 'not-rapid',
      last_height: 101,
      deposit: '100000000 THOR.RUNE',
      in: '100000000 THOR.RUNE',
      out: '200000000 ETH.ETH',
      raw_hint: {
        interval: 0,
        quantity: 2,
        count: 2
      }
    }, {
      observedAt: '2026-04-02T12:00:00.000Z',
      priceIndex: {
        prices: new Map([
          ['THOR.RUNE', 1],
          ['ETH.ETH', 2000]
        ]),
        runePriceUsd: 1
      }
    });

    assert.equal(result.row, null);
    assert.equal(result.terminal, true);
    assert.equal(result.resolvedBy, 'not_rapid');
  } finally {
    global.fetch = originalFetch;
  }
});
