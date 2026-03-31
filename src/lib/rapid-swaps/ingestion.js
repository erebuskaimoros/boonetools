function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function safeString(value) {
  return String(value || '');
}

function safeStats(syncState) {
  return syncState?.stats_json && typeof syncState.stats_json === 'object'
    ? syncState.stats_json
    : {};
}

export function buildRapidSwapCanonicalScanPlan(options = {}) {
  const syncState = options.syncState || null;
  const headMaxPages = Math.max(1, Math.trunc(safeNumber(options.headMaxPages || options.maxPages, 200)));
  const catchupMaxPages = Math.max(1, Math.trunc(safeNumber(options.catchupMaxPages || headMaxPages, headMaxPages)));
  const overlapBlocks = Math.max(0, Math.trunc(safeNumber(options.overlapBlocks, 0)));
  const lastScannedHeight = Math.max(0, Math.trunc(safeNumber(syncState?.last_scanned_height, 0)));
  const stopBelowHeight = lastScannedHeight > 0
    ? Math.max(0, lastScannedHeight - overlapBlocks)
    : 0;
  const stats = safeStats(syncState);
  const catchupNextPageToken = safeString(stats.catchup_next_page_token || stats.next_page_token);
  const catchupStopBelowHeight = Math.max(
    0,
    Math.trunc(safeNumber(stats.catchup_stop_below_height || stats.stop_below_height, stopBelowHeight))
  );
  const lagging = Boolean(stats.lagging);

  return {
    head: {
      maxPages: headMaxPages,
      stopBelowHeight
    },
    catchup: lagging && catchupNextPageToken && catchupStopBelowHeight > 0
      ? {
          maxPages: catchupMaxPages,
          nextPageToken: catchupNextPageToken,
          stopBelowHeight: catchupStopBelowHeight
        }
      : null
  };
}

export function summarizeRapidSwapCanonicalScan(options = {}) {
  const syncState = options.syncState || null;
  const plan = options.plan || buildRapidSwapCanonicalScanPlan({
    syncState,
    overlapBlocks: options.overlapBlocks,
    headMaxPages: options.headMaxPages,
    catchupMaxPages: options.catchupMaxPages
  });
  const headScan = options.headScan || {};
  const catchupScan = options.catchupScan || null;
  const previousLastScannedHeight = Math.max(0, Math.trunc(safeNumber(syncState?.last_scanned_height, 0)));
  const previousStats = safeStats(syncState);
  const headStopBelowHeight = Math.max(0, Math.trunc(safeNumber(plan?.head?.stopBelowHeight, 0)));
  const headHighestHeight = Math.max(0, Math.trunc(safeNumber(headScan.highestHeight, 0)));
  const headLagging = headStopBelowHeight > 0
    && !Boolean(headScan.reachedStopHeight)
    && Boolean(headScan.nextPageToken);

  const activeCatchupStopBelowHeight = Math.max(
    0,
    Math.trunc(
      safeNumber(
        plan?.catchup?.stopBelowHeight,
        previousStats.catchup_stop_below_height || previousStats.stop_below_height
      )
    )
  );
  const activeCatchupNextPageToken = safeString(
    plan?.catchup?.nextPageToken || previousStats.catchup_next_page_token || previousStats.next_page_token
  );
  const catchupReachedFloor = Boolean(catchupScan)
    ? activeCatchupStopBelowHeight === 0 || Boolean(catchupScan.reachedStopHeight)
    : false;
  const catchupLagging = Boolean(catchupScan)
    ? activeCatchupStopBelowHeight > 0 && !catchupReachedFloor && Boolean(catchupScan.nextPageToken)
    : false;

  let lagging = false;
  let catchupNextPageToken = '';
  let catchupStopBelowHeight = 0;

  if (catchupScan) {
    lagging = catchupLagging;
    catchupNextPageToken = catchupLagging ? safeString(catchupScan.nextPageToken) : '';
    catchupStopBelowHeight = catchupLagging ? activeCatchupStopBelowHeight : 0;
  } else if (headLagging) {
    lagging = true;
    catchupNextPageToken = safeString(headScan.nextPageToken);
    catchupStopBelowHeight = headStopBelowHeight;
  }

  const canAdvanceWatermark = headStopBelowHeight === 0
    || Boolean(headScan.reachedStopHeight)
    || (headLagging && catchupReachedFloor);

  return {
    lastScannedHeight: canAdvanceWatermark
      ? Math.max(previousLastScannedHeight, headHighestHeight)
      : previousLastScannedHeight,
    lagging,
    stats: {
      stop_below_height: headStopBelowHeight,
      highest_height_seen: headHighestHeight,
      lowest_height_seen: Math.max(0, Math.trunc(safeNumber(headScan.lowestHeight, 0))),
      reached_stop_height: Boolean(headScan.reachedStopHeight),
      lagging,
      next_page_token: catchupNextPageToken,
      catchup_next_page_token: catchupNextPageToken,
      catchup_stop_below_height: catchupStopBelowHeight,
      catchup_highest_height_seen: Math.max(0, Math.trunc(safeNumber(catchupScan?.highestHeight, 0))),
      catchup_lowest_height_seen: Math.max(0, Math.trunc(safeNumber(catchupScan?.lowestHeight, 0))),
      catchup_reached_stop_height: catchupReachedFloor,
      catchup_loaded_from_state: Boolean(plan?.catchup && activeCatchupNextPageToken),
      head_scanned_pages: Math.max(0, Math.trunc(safeNumber(headScan.scannedPages, 0))),
      head_scanned_actions: Math.max(0, Math.trunc(safeNumber(headScan.scannedActions, 0))),
      catchup_scanned_pages: Math.max(0, Math.trunc(safeNumber(catchupScan?.scannedPages, 0))),
      catchup_scanned_actions: Math.max(0, Math.trunc(safeNumber(catchupScan?.scannedActions, 0))),
      lagging_started_at: lagging
        ? safeString(previousStats.lagging_started_at) || new Date().toISOString()
        : null
    }
  };
}

export function mergeRapidSwapRowsByTxId(...groups) {
  const rowsByTxId = new Map();

  for (const group of groups) {
    for (const row of Array.isArray(group) ? group : []) {
      const txId = safeString(row?.tx_id);
      if (!txId) {
        continue;
      }
      rowsByTxId.set(txId, row);
    }
  }

  return [...rowsByTxId.values()];
}
