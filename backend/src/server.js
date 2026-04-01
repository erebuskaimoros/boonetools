import http from 'node:http';
import { config } from './lib/config.js';
import {
  CORS_HEADERS,
  error,
  isAuthorizedPublicRequest,
  normalizeRoutePath,
  parseUrl,
  sendResponse
} from './lib/http.js';
import { closePool, query } from './db/pool.js';
import { handleBondHistory } from './handlers/bond-history.js';
import { handleHealth } from './handlers/health.js';
import { handleNodeopLeaderboard } from './handlers/nodeop-leaderboard.js';
import { handleNodeopMeta } from './handlers/nodeop-meta.js';
import { handleNodeopPerformance } from './handlers/nodeop-performance.js';
import { handleRapidSwaps } from './handlers/rapid-swaps.js';
import { handleStockPrices } from './handlers/stock-prices.js';

const routes = new Map([
  ['/', { auth: 'none', handler: handleHealth }],
  ['/health', { auth: 'none', handler: handleHealth }],
  ['/nodeop-performance', { auth: 'public', handler: handleNodeopPerformance }],
  ['/nodeop-leaderboard', { auth: 'public', handler: handleNodeopLeaderboard }],
  ['/nodeop-meta', { auth: 'public', handler: handleNodeopMeta }],
  ['/rapid-swaps', { auth: 'public', handler: handleRapidSwaps }],
  ['/bond-history', { auth: 'public', handler: handleBondHistory }],
  ['/stock-prices', { auth: 'public', handler: handleStockPrices }]
]);

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

  if (route.auth === 'public' && !isAuthorizedPublicRequest(request)) {
    sendResponse(response, error('Forbidden', 403));
    return;
  }

  try {
    const result = await route.handler(request, url);
    sendResponse(response, result);
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
