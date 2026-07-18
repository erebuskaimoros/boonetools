import http from 'node:http';
import { config } from './lib/config.js';
import { applyApiContract } from './lib/api-contract.js';
import {
  CORS_HEADERS,
  error,
  normalizeRoutePath,
  parseUrl,
  sendResponse
} from './lib/http.js';
import { createFixedWindowRateLimiter } from './lib/rate-limit.js';
import { closePool, query } from './db/pool.js';
import { handleAppLayerBaseLayerEarnings } from './handlers/app-layer-base-layer-earnings.js';
import { handleAppLayerBaseFees } from './handlers/app-layer-base-fees.js';
import { handleAppLayerLiveState } from './handlers/app-layer-live-state.js';
import { handleAppLayerReservePayments } from './handlers/app-layer-reserve-payments.js';
import { handleBondHistory } from './handlers/bond-history.js';
import { handleHealth } from './handlers/health.js';
import { handleNodeopLeaderboard } from './handlers/nodeop-leaderboard.js';
import { handleNodeopMeta } from './handlers/nodeop-meta.js';
import { handleNodeopPerformance } from './handlers/nodeop-performance.js';
import { handleNodeVotes } from './handlers/node-votes.js';
import { handleNetworkSnapshot } from './handlers/network-snapshot.js';
import { handleRapidSwaps } from './handlers/rapid-swaps.js';
import { handleRapidSwapsSwapHistory } from './handlers/rapid-swaps-swap-history.js';
import { handleStockPrices } from './handlers/stock-prices.js';
import { handleStuckTransactions } from './handlers/stuck-transactions.js';
import { handleTcFeeDash } from './handlers/tc-fee-dash.js';

const routes = new Map([
  ['/', { auth: 'none', handler: handleHealth }],
  ['/health', { auth: 'none', handler: handleHealth }],
  ['/nodeop-performance', { auth: 'none', handler: handleNodeopPerformance }],
  ['/nodeop-leaderboard', { auth: 'none', handler: handleNodeopLeaderboard }],
  ['/nodeop-meta', { auth: 'none', handler: handleNodeopMeta }],
  ['/node-votes', { auth: 'none', handler: handleNodeVotes }],
  ['/network-snapshot', { auth: 'none', handler: handleNetworkSnapshot }],
  ['/tc-fee-dash', { auth: 'none', handler: handleTcFeeDash }],
  ['/rapid-swaps', { auth: 'none', handler: handleRapidSwaps }],
  ['/rapid-swaps-swap-history', { auth: 'none', handler: handleRapidSwapsSwapHistory }],
  ['/bond-history', { auth: 'none', handler: handleBondHistory }],
  ['/app-layer-base-layer-earnings', { auth: 'none', handler: handleAppLayerBaseLayerEarnings }],
  ['/app-layer-base-fees', { auth: 'none', handler: handleAppLayerBaseFees }],
  ['/app-layer-live-state', { auth: 'none', handler: handleAppLayerLiveState }],
  ['/app-layer-reserve-payments', { auth: 'none', handler: handleAppLayerReservePayments }],
  ['/stock-prices', { auth: 'none', handler: handleStockPrices }],
  ['/stuck-transactions', { auth: 'none', handler: handleStuckTransactions }]
]);

const checkRateLimit = createFixedWindowRateLimiter();

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS_HEADERS);
    response.end();
    return;
  }

  const url = parseUrl(request);
  const pathname = normalizeRoutePath(url.pathname);
  const route = routes.get(pathname);

  if (!route) {
    sendResponse(response, error('Not found', 404));
    return;
  }

  if (request.method !== 'GET') {
    sendResponse(response, error(`Method ${request.method} not allowed`, 405));
    return;
  }

  if (pathname !== '/' && pathname !== '/health') {
    const rateLimit = checkRateLimit(request);
    if (!rateLimit.allowed) {
      sendResponse(response, error('Rate limit exceeded', 429, {
        'Retry-After': String(rateLimit.retryAfterSeconds),
        'X-RateLimit-Limit': String(rateLimit.limit),
        'X-RateLimit-Remaining': String(rateLimit.remaining)
      }));
      return;
    }
  }

  try {
    const result = await route.handler(request, url);
    sendResponse(response, applyApiContract(result, {
      request,
      url,
      route: pathname
    }));
  } catch (routeError) {
    console.error(`${pathname} failed:`, routeError);
    sendResponse(response, error(routeError.message || 'Internal error', 500));
  }
});

await query('select 1');

server.listen(config.port, '127.0.0.1', () => {
  console.log(`BooneTools backend listening on 127.0.0.1:${config.port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down backend...`);
  server.close(async () => {
    await closePool().catch(() => {});
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
