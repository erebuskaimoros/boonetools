import { CHAIN_HEAD_NOTIFY_CHANNEL, loadLatestChainHead } from '../shared/chain-headers.js';
import { CORS_HEADERS } from './http.js';

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_RECONNECT_MS = 3_000;

function parseHead(value) {
  try {
    const payload = typeof value === 'string' ? JSON.parse(value) : value;
    const height = Number(payload?.height);
    const time = String(payload?.time || '');
    if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(Date.parse(time))) return null;
    return { ...payload, height: Math.trunc(height), time: new Date(time).toISOString() };
  } catch {
    return null;
  }
}

export function formatChainHeadSse(head) {
  const payload = parseHead(head);
  if (!payload) return '';
  return `id: ${payload.height}\nevent: head\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function createChainEventBroker(options = {}) {
  const getClient = options.getClient;
  const loadLatest = options.loadLatest || loadLatestChainHead;
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const log = options.log || (() => {});
  const clients = new Set();
  let listenerClient = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let latestHead = null;
  let stopped = true;
  let connecting = null;

  if (typeof getClient !== 'function') {
    throw new Error('Chain event broker requires a PostgreSQL client factory');
  }

  function broadcastFrame(frame) {
    if (!frame) return;
    for (const response of clients) {
      if (response.destroyed || response.writableEnded) {
        clients.delete(response);
        continue;
      }
      try {
        response.write(frame);
      } catch {
        clients.delete(response);
      }
    }
  }

  function publish(head) {
    const normalized = parseHead(head);
    if (!normalized) return false;
    if (!latestHead || normalized.height >= latestHead.height) latestHead = normalized;
    broadcastFrame(formatChainHeadSse(normalized));
    return true;
  }

  function releaseListenerClient(client = listenerClient) {
    if (!client) return;
    client.removeListener?.('notification', onNotification);
    client.removeListener?.('error', onListenerError);
    client.release?.(true);
    if (listenerClient === client) listenerClient = null;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      connect().catch(() => {});
    }, Number(options.reconnectMs) || DEFAULT_RECONNECT_MS);
  }

  function onNotification(message) {
    if (message?.channel !== CHAIN_HEAD_NOTIFY_CHANNEL) return;
    publish(message.payload);
  }

  function onListenerError(error) {
    log(`Chain event LISTEN connection failed: ${error?.message || error}`);
    releaseListenerClient();
    scheduleReconnect();
  }

  async function connect() {
    if (stopped || listenerClient) return;
    if (connecting) return connecting;
    connecting = (async () => {
      let client;
      try {
        client = await getClient();
        if (stopped) {
          client.release?.();
          return;
        }
        client.on?.('notification', onNotification);
        client.on?.('error', onListenerError);
        await client.query(`listen ${CHAIN_HEAD_NOTIFY_CHANNEL}`);
        listenerClient = client;
        const latest = await loadLatest(client).catch(() => null);
        if (latest) latestHead = parseHead(latest);
      } catch (error) {
        releaseListenerClient(client);
        log(`Unable to start chain event LISTEN connection: ${error?.message || error}`);
        scheduleReconnect();
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  async function start() {
    if (!stopped) return;
    stopped = false;
    clearIntervalFn(heartbeatTimer);
    heartbeatTimer = setIntervalFn(() => broadcastFrame(': keepalive\n\n'), (
      Number(options.heartbeatMs) || DEFAULT_HEARTBEAT_MS
    ));
    await connect();
  }

  function subscribe(request, response, onClose = () => {}) {
    response.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.flushHeaders?.();
    response.write('retry: 3000\n\n');
    if (latestHead) response.write(formatChainHeadSse(latestHead));
    clients.add(response);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clients.delete(response);
      onClose();
    };
    request.once?.('close', cleanup);
    response.once?.('close', cleanup);
    return cleanup;
  }

  async function stop() {
    stopped = true;
    clearTimeoutFn(reconnectTimer);
    clearIntervalFn(heartbeatTimer);
    reconnectTimer = null;
    heartbeatTimer = null;
    const client = listenerClient;
    listenerClient = null;
    if (client) {
      await client.query(`unlisten ${CHAIN_HEAD_NOTIFY_CHANNEL}`).catch(() => {});
      releaseListenerClient(client);
    }
    for (const response of clients) response.end?.();
    clients.clear();
  }

  return {
    connect,
    getClientCount: () => clients.size,
    getLatestHead: () => latestHead,
    publish,
    start,
    stop,
    subscribe
  };
}
