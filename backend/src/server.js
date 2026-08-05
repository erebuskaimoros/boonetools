import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { config } from './lib/config.js';
import { applyApiContract } from './lib/api-contract.js';
import {
  CORS_HEADERS,
  error,
  normalizeRoutePath,
  parseUrl,
  sendResponse
} from './lib/http.js';
import { createConcurrencyLimiter, createFixedWindowRateLimiter } from './lib/rate-limit.js';
import { createChainEventBroker } from './lib/chain-event-broker.js';
import { closePool, getClient, query } from './db/pool.js';
import { handleAppLayerBaseLayerEarnings } from './handlers/app-layer-base-layer-earnings.js';
import { handleAppLayerBaseFees } from './handlers/app-layer-base-fees.js';
import { handleAppLayerLiveState } from './handlers/app-layer-live-state.js';
import { handleAppLayerReservePayments } from './handlers/app-layer-reserve-payments.js';
import { handleBondHistory } from './handlers/bond-history.js';
import { handleBlockProduction } from './handlers/block-production.js';
import { handleDynamicFeeAffiliateVolume } from './handlers/dynamic-fee-affiliate-volume.js';
import { handleDynamicFeeTransactions } from './handlers/dynamic-fee-transactions.js';
import { handleHealth } from './handlers/health.js';
import { handleNodeopLeaderboard } from './handlers/nodeop-leaderboard.js';
import { handleNodeopMeta } from './handlers/nodeop-meta.js';
import { handleNodeopPerformance } from './handlers/nodeop-performance.js';
import {
  handleNodeVoteDetails,
  handleNodeVoteNodeDetails,
  handleNodeVotes,
  handleNodeVotesSummary
} from './handlers/node-votes.js';
import { handleNetworkSnapshot } from './handlers/network-snapshot.js';
import { handlePoolDislocation, handlePoolDislocationSeries } from './handlers/pool-dislocation.js';
import { handleRapidSwaps, handleRapidSwapsSummary } from './handlers/rapid-swaps.js';
import { handleRapidSwapsSwapHistory } from './handlers/rapid-swaps-swap-history.js';
import { handleStockPrices } from './handlers/stock-prices.js';
import { handleStuckTransactions } from './handlers/stuck-transactions.js';
import { handleStatusDashboard } from './handlers/status-dashboard.js';
import { handleStatusLive } from './handlers/status-live.js';
import { handleTcFeeDash } from './handlers/tc-fee-dash.js';
import { handleTreasurySnapshot } from './handlers/treasury-snapshot.js';
import { handleWasmArbEconomics } from './handlers/wasm-arb-economics.js';

function route(handler, cost = 1, maxConcurrent = 8) {
  return { auth: 'none', handler, cost, maxConcurrent };
}

function streamRoute(cost = 1, maxConcurrent = 100) {
  return { auth: 'none', stream: true, cost, maxConcurrent };
}

const routes = new Map([
  ['/', route(handleHealth, 0, 100)],
  ['/health', route(handleHealth, 0, 100)],
  ['/nodeop-performance', route(handleNodeopPerformance, 2, 4)],
  ['/nodeop-leaderboard', route(handleNodeopLeaderboard, 2, 4)],
  ['/nodeop-meta', route(handleNodeopMeta, 2, 4)],
  ['/node-votes', route(handleNodeVotes, 5, 3)],
  ['/node-votes-summary', route(handleNodeVotesSummary, 1, 64)],
  ['/node-votes/vote', route(handleNodeVoteDetails, 2, 6)],
  ['/node-votes/node', route(handleNodeVoteNodeDetails, 2, 6)],
  ['/status-dashboard', route(handleStatusDashboard, 1, 64)],
  ['/status-live', route(handleStatusLive, 1, 64)],
  ['/network-snapshot', route(handleNetworkSnapshot, 1, 64)],
  ['/pool-dislocation', route(handlePoolDislocation, 1, 64)],
  ['/pool-dislocation-series', route(handlePoolDislocationSeries, 2, 16)],
  ['/tc-fee-dash', route(handleTcFeeDash, 1, 64)],
  ['/rapid-swaps', route(handleRapidSwaps, 5, 3)],
  ['/rapid-swaps-summary', route(handleRapidSwapsSummary, 1, 64)],
  ['/rapid-swaps-swap-history', route(handleRapidSwapsSwapHistory, 1, 64)],
  ['/bond-history', route(handleBondHistory, 4, 3)],
  ['/block-production', route(handleBlockProduction, 1, 64)],
  ['/chain-events', streamRoute(1, 100)],
  ['/dynamic-fee-affiliate-volume', route(handleDynamicFeeAffiliateVolume, 5, 2)],
  ['/dynamic-fee-transactions', route(handleDynamicFeeTransactions, 5, 2)],
  ['/app-layer-base-layer-earnings', route(handleAppLayerBaseLayerEarnings, 1, 64)],
  ['/app-layer-base-fees', route(handleAppLayerBaseFees, 1, 64)],
  ['/app-layer-live-state', route(handleAppLayerLiveState, 1, 64)],
  ['/app-layer-reserve-payments', route(handleAppLayerReservePayments, 1, 64)],
  ['/stock-prices', route(handleStockPrices, 2, 4)],
  ['/stuck-transactions', route(handleStuckTransactions, 3, 3)],
  ['/treasury-snapshot', route(handleTreasurySnapshot, 1, 64)],
  ['/wasm-arb-economics', route(handleWasmArbEconomics, 1, 64)]
]);

const checkRateLimit = createFixedWindowRateLimiter();
const acquireConcurrency = createConcurrencyLimiter();
const chainEventBroker = createChainEventBroker({
  getClient,
  log: (message) => console.error(JSON.stringify({ type: 'chain_event_broker', message }))
});

const server = http.createServer(async (request, response) => {
  const startedAt = performance.now();
  let pathname = '/';
  let rateLimitCost = 0;

  function respond(result) {
    const handlerDurationMs = performance.now() - startedAt;
    const timingValue = `app;dur=${handlerDurationMs.toFixed(1)}`;
    const timedResult = {
      ...result,
      headers: {
        ...result?.headers,
        'Server-Timing': result?.headers?.['Server-Timing']
          ? `${result.headers['Server-Timing']}, ${timingValue}`
          : timingValue
      }
    };
    const written = sendResponse(response, timedResult);
    console.log(JSON.stringify({
      type: 'http_request',
      method: request.method || '',
      path: pathname,
      status: written.status,
      duration_ms: Number((performance.now() - startedAt).toFixed(1)),
      response_bytes: written.bytes,
      rate_limit_cost: rateLimitCost,
      cache: timedResult.headers?.['X-Boone-Cache'] || null
    }));
    return written;
  }

  if (request.method === 'OPTIONS') {
    respond({ status: 204, headers: CORS_HEADERS });
    return;
  }

  const url = parseUrl(request);
  pathname = normalizeRoutePath(url.pathname);
  const route = routes.get(pathname);

  if (!route) {
    respond(error('Not found', 404));
    return;
  }

  if (request.method !== 'GET') {
    respond(error(`Method ${request.method} not allowed`, 405));
    return;
  }

  if (pathname !== '/' && pathname !== '/health') {
    rateLimitCost = route.cost;
    const rateLimit = checkRateLimit(request, route.cost);
    if (!rateLimit.allowed) {
      respond(error('Rate limit exceeded', 429, {
        'Retry-After': String(rateLimit.retryAfterSeconds),
        'X-RateLimit-Limit': String(rateLimit.limit),
        'X-RateLimit-Remaining': String(rateLimit.remaining)
      }));
      return;
    }
  }

  const concurrency = acquireConcurrency(pathname, route.maxConcurrent);
  if (!concurrency.allowed) {
    respond(error('Endpoint is busy; retry shortly', 503, {
      'Retry-After': '1'
    }));
    return;
  }

  if (route.stream) {
    const streamStartedAt = performance.now();
    chainEventBroker.subscribe(request, response, () => {
      concurrency.release();
      console.log(JSON.stringify({
        type: 'sse_disconnect',
        path: pathname,
        duration_ms: Number((performance.now() - streamStartedAt).toFixed(1))
      }));
    });
    console.log(JSON.stringify({
      type: 'sse_connect',
      path: pathname,
      clients: chainEventBroker.getClientCount(),
      rate_limit_cost: rateLimitCost
    }));
    return;
  }

  try {
    const result = await route.handler(request, url);
    respond(applyApiContract(result, {
      request,
      url,
      route: pathname
    }));
  } catch (routeError) {
    console.error(JSON.stringify({
      type: 'http_error',
      path: pathname,
      message: routeError.message || 'Internal error'
    }));
    respond(error(routeError.message || 'Internal error', 500));
  } finally {
    concurrency.release();
  }
});

await query('select 1');
await chainEventBroker.start();

server.listen(config.port, '127.0.0.1', () => {
  console.log(`BooneTools backend listening on 127.0.0.1:${config.port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down backend...`);
  await chainEventBroker.stop().catch(() => {});
  server.close(async () => {
    await closePool().catch(() => {});
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
