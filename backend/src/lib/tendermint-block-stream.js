import WebSocket from 'ws';

export const NEW_BLOCK_SUBSCRIPTION = Object.freeze({
  jsonrpc: '2.0',
  method: 'subscribe',
  id: 1,
  params: { query: "tm.event='NewBlock'" }
});

export function parseTendermintNewBlockMessage(message) {
  if (message?.result && !message.result.data) {
    return null;
  }

  const data = message?.result?.data?.value;
  if (!data) {
    return null;
  }

  const blockHeight = Number(data?.block?.header?.height) || 0;
  if (blockHeight <= 0) {
    return null;
  }

  const rawBlockTime = String(data?.block?.header?.time || '');
  const blockTime = rawBlockTime && Number.isFinite(Date.parse(rawBlockTime))
    ? new Date(rawBlockTime).toISOString()
    : null;

  return { data, blockHeight, blockTime, message };
}

export function createTendermintBlockStream(options = {}) {
  const urls = [...new Set((Array.isArray(options.urls) ? options.urls : [options.urls]).filter(Boolean))];
  const WebSocketCtor = options.WebSocketCtor || WebSocket;
  const now = options.now || (() => Date.now());
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const logger = options.log || (() => {});
  const reconnectBaseMs = Math.max(1, Number(options.reconnectBaseMs) || 1000);
  const reconnectMaxMs = Math.max(reconnectBaseMs, Number(options.reconnectMaxMs) || 30000);
  const pingIntervalMs = Math.max(1, Number(options.pingIntervalMs) || 30000);
  const stallCheckIntervalMs = Math.max(1, Number(options.stallCheckIntervalMs) || 30000);
  const stallMs = Math.max(1, Number(options.stallMs) || 180000);

  if (urls.length === 0) {
    throw new Error('At least one Tendermint WebSocket URL is required');
  }

  let socket = null;
  let stopped = true;
  let reconnectAttempt = 0;
  let activeUrlIndex = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let stallTimer = null;
  let connectedAt = 0;
  let lastBlockHeight = 0;
  let lastBlockReceivedAt = 0;
  let blocksReceived = 0;

  function activeUrl() {
    return urls[activeUrlIndex % urls.length];
  }

  function rotateUrl() {
    if (urls.length > 1) {
      activeUrlIndex = (activeUrlIndex + 1) % urls.length;
    }
  }

  function clearConnectionTimers() {
    clearIntervalFn(pingTimer);
    clearIntervalFn(stallTimer);
    pingTimer = null;
    stallTimer = null;
  }

  function reportError(error) {
    try {
      options.onError?.(error, getState());
    } catch {
      // A reporting callback must not break reconnection or cleanup.
    }
  }

  function isStalled() {
    if (!connectedAt) {
      return false;
    }
    return now() - (lastBlockReceivedAt || connectedAt) > stallMs;
  }

  function getState() {
    const hasSeenBlock = lastBlockHeight > 0 && lastBlockReceivedAt > 0;
    const blockStallSeconds = hasSeenBlock
      ? Math.max(0, Math.floor((now() - lastBlockReceivedAt) / 1000))
      : null;
    return {
      connected: Boolean(connectedAt),
      connectedAt,
      currentUrl: activeUrl(),
      activeUrlIndex,
      reconnectAttempt,
      lastBlockHeight,
      lastBlockReceivedAt,
      blocksReceived,
      blockStallSeconds,
      streamStatus: !hasSeenBlock ? 'starting' : isStalled() ? 'stalled' : 'running'
    };
  }

  function scheduleReconnect(connect) {
    if (stopped || reconnectTimer) {
      return;
    }
    const delay = Math.min(reconnectBaseMs * Math.pow(2, reconnectAttempt), reconnectMaxMs);
    reconnectAttempt += 1;
    logger(`Reconnecting in ${delay}ms (attempt ${reconnectAttempt})...`);
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopped) {
      return;
    }

    const rpcWsUrl = activeUrl();
    let opened = false;
    let currentSocket;
    logger(`Connecting to ${rpcWsUrl}...`);

    try {
      currentSocket = new WebSocketCtor(rpcWsUrl, {
        headers: { 'x-client-id': options.clientId || 'BooneTools' }
      });
      socket = currentSocket;
    } catch (error) {
      reportError(error);
      rotateUrl();
      scheduleReconnect(connect);
      return;
    }

    currentSocket.on('open', () => {
      if (stopped || socket !== currentSocket) {
        return;
      }
      opened = true;
      connectedAt = now();
      reconnectAttempt = 0;
      currentSocket.send(JSON.stringify(options.subscription || NEW_BLOCK_SUBSCRIPTION));
      try {
        options.onOpen?.(getState());
      } catch (error) {
        reportError(error);
      }

      clearConnectionTimers();
      pingTimer = setIntervalFn(() => {
        if (currentSocket.readyState === WebSocketCtor.OPEN) {
          currentSocket.ping();
        }
      }, pingIntervalMs);
      stallTimer = setIntervalFn(() => {
        if (currentSocket.readyState !== WebSocketCtor.OPEN || !isStalled()) {
          return;
        }
        logger(`WebSocket block stream stalled at block ${lastBlockHeight || 'none'}; reconnecting...`);
        rotateUrl();
        currentSocket.terminate();
      }, stallCheckIntervalMs);
    });

    currentSocket.on('message', (frame) => {
      let message;
      try {
        message = JSON.parse(frame.toString());
      } catch {
        return;
      }

      const block = parseTendermintNewBlockMessage(message);
      if (!block) {
        return;
      }

      lastBlockHeight = block.blockHeight;
      lastBlockReceivedAt = now();
      blocksReceived += 1;
      Promise.resolve()
        .then(() => options.onBlock?.(block, getState()))
        .catch((error) => {
          try {
            options.onProcessingError?.(error, block, getState());
          } catch (reportingError) {
            reportError(reportingError);
          }
        });
    });

    currentSocket.on('close', (code, reason) => {
      if (socket === currentSocket) {
        socket = null;
      }
      clearConnectionTimers();
      connectedAt = 0;
      try {
        options.onClose?.({ code, reason: String(reason || ''), opened }, getState());
      } catch (error) {
        reportError(error);
      }
      if (stopped) {
        return;
      }
      if (!opened) {
        rotateUrl();
      }
      scheduleReconnect(connect);
    });

    currentSocket.on('error', (error) => {
      reportError(error);
    });
  }

  function start() {
    if (!stopped) {
      return;
    }
    stopped = false;
    connect();
  }

  function stop() {
    stopped = true;
    clearTimeoutFn(reconnectTimer);
    reconnectTimer = null;
    clearConnectionTimers();
    connectedAt = 0;
    if (socket) {
      const currentSocket = socket;
      socket = null;
      currentSocket.removeAllListeners();
      currentSocket.close();
    }
  }

  return {
    getState,
    isStalled,
    start,
    stop
  };
}
