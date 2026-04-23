import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRapidSwapCanonicalScanPlan,
  mergeRapidSwapRowsByTxId,
  shouldSkipRapidSwapCanonicalScanForHealthyListener,
  summarizeRapidSwapCanonicalScan
} from '../src/lib/rapid-swaps/ingestion.js';

test('buildRapidSwapCanonicalScanPlan loads the saved catch-up cursor when lagging', () => {
  const plan = buildRapidSwapCanonicalScanPlan({
    syncState: {
      last_scanned_height: 5000,
      last_scanned_at: '2026-04-01T00:00:00.000Z',
      stats_json: {
        lagging: true,
        catchup_next_page_token: 'cursor-123',
        catchup_stop_below_height: 3200
      }
    },
    nowMs: Date.parse('2026-04-01T00:20:00.000Z'),
    overlapBlocks: 1800,
    headMaxPages: 200,
    catchupMaxPages: 80,
    normalHeadPages: 4,
    laggingHeadPages: 2,
    catchupPages: 3,
    scanIntervalMs: 15 * 60 * 1000
  });

  assert.deepEqual(plan, {
    shouldScan: true,
    skipReason: '',
    nextScanAt: '',
    head: {
      maxPages: 2,
      stopBelowHeight: 3200
    },
    catchup: {
      maxPages: 3,
      nextPageToken: 'cursor-123',
      stopBelowHeight: 3200
    }
  });
});

test('buildRapidSwapCanonicalScanPlan skips until the scan interval elapses', () => {
  const plan = buildRapidSwapCanonicalScanPlan({
    syncState: {
      last_scanned_height: 5000,
      last_scanned_at: '2026-04-01T00:00:00.000Z',
      stats_json: {}
    },
    nowMs: Date.parse('2026-04-01T00:05:00.000Z'),
    scanIntervalMs: 15 * 60 * 1000
  });

  assert.deepEqual(plan, {
    shouldScan: false,
    skipReason: 'scan_interval',
    nextScanAt: '2026-04-01T00:15:00.000Z',
    head: null,
    catchup: null
  });
});

test('buildRapidSwapCanonicalScanPlan skips during provider cooldown', () => {
  const plan = buildRapidSwapCanonicalScanPlan({
    syncState: {
      last_scanned_height: 5000,
      stats_json: {
        rate_limited_until: '2026-04-01T02:00:00.000Z'
      }
    },
    nowMs: Date.parse('2026-04-01T01:00:00.000Z')
  });

  assert.deepEqual(plan, {
    shouldScan: false,
    skipReason: 'rate_limited',
    nextScanAt: '2026-04-01T02:00:00.000Z',
    head: null,
    catchup: null
  });
});

test('shouldSkipRapidSwapCanonicalScanForHealthyListener skips canonical scans while the websocket listener is stable', () => {
  assert.equal(shouldSkipRapidSwapCanonicalScanForHealthyListener({
    finished_at: '2026-04-01T00:19:30.000Z',
    status: 'running',
    stats_json: {
      uptime_seconds: 1200,
      blocks_processed: 400
    }
  }, {
    nowMs: Date.parse('2026-04-01T00:20:00.000Z'),
    heartbeatGraceMs: 3 * 60 * 1000,
    stableUptimeMs: 10 * 60 * 1000
  }), true);
});

test('shouldSkipRapidSwapCanonicalScanForHealthyListener allows recovery scans after listener restarts', () => {
  assert.equal(shouldSkipRapidSwapCanonicalScanForHealthyListener({
    finished_at: '2026-04-01T00:19:30.000Z',
    status: 'running',
    stats_json: {
      uptime_seconds: 45,
      blocks_processed: 12
    }
  }, {
    nowMs: Date.parse('2026-04-01T00:20:00.000Z'),
    heartbeatGraceMs: 3 * 60 * 1000,
    stableUptimeMs: 10 * 60 * 1000
  }), false);
});

test('summarizeRapidSwapCanonicalScan seeds catch-up state when the head scan falls behind', () => {
  const plan = buildRapidSwapCanonicalScanPlan({
    syncState: {
      last_scanned_height: 5000,
      stats_json: {}
    },
    overlapBlocks: 1800,
    headMaxPages: 200
  });

  const summary = summarizeRapidSwapCanonicalScan({
    syncState: {
      last_scanned_height: 5000,
      stats_json: {}
    },
    plan,
    headScan: {
      highestHeight: 6200,
      lowestHeight: 4100,
      reachedStopHeight: false,
      nextPageToken: 'cursor-456',
      scannedPages: 200,
      scannedActions: 10000
    }
  });

  assert.equal(summary.lastScannedHeight, 5000);
  assert.equal(summary.lagging, true);
  assert.equal(summary.stats.catchup_next_page_token, 'cursor-456');
  assert.equal(summary.stats.catchup_stop_below_height, 3200);
  assert.equal(summary.stats.lagging_started_at !== null, true);
});

test('summarizeRapidSwapCanonicalScan treats known-page early stop as caught up', () => {
  const syncState = {
    last_scanned_height: 5000,
    stats_json: {}
  };

  const plan = buildRapidSwapCanonicalScanPlan({
    syncState,
    overlapBlocks: 1800,
    headMaxPages: 200
  });

  const summary = summarizeRapidSwapCanonicalScan({
    syncState,
    plan,
    headScan: {
      highestHeight: 6200,
      lowestHeight: 5900,
      reachedStopHeight: false,
      stoppedEarly: true,
      nextPageToken: 'cursor-after-known-pages',
      scannedPages: 3,
      scannedActions: 150
    }
  });

  assert.equal(summary.lastScannedHeight, 6200);
  assert.equal(summary.lagging, false);
  assert.equal(summary.stats.catchup_next_page_token, '');
  assert.equal(summary.stats.catchup_stop_below_height, 0);
});

test('summarizeRapidSwapCanonicalScan clears lagging after a catch-up scan reaches the floor', () => {
  const syncState = {
    last_scanned_height: 5000,
    stats_json: {
      lagging: true,
      catchup_next_page_token: 'cursor-123',
      catchup_stop_below_height: 3200,
      lagging_started_at: '2026-03-31T12:00:00.000Z'
    }
  };
  const plan = buildRapidSwapCanonicalScanPlan({
    syncState,
    overlapBlocks: 1800,
    headMaxPages: 200,
    catchupMaxPages: 80
  });

  const summary = summarizeRapidSwapCanonicalScan({
    syncState,
    plan,
    headScan: {
      highestHeight: 6300,
      lowestHeight: 4200,
      reachedStopHeight: false,
      nextPageToken: 'cursor-newer',
      scannedPages: 200,
      scannedActions: 10000
    },
    catchupScan: {
      highestHeight: 4199,
      lowestHeight: 3100,
      reachedStopHeight: true,
      nextPageToken: '',
      scannedPages: 20,
      scannedActions: 1000
    }
  });

  assert.equal(summary.lastScannedHeight, 6300);
  assert.equal(summary.lagging, false);
  assert.equal(summary.stats.catchup_next_page_token, '');
  assert.equal(summary.stats.catchup_stop_below_height, 0);
  assert.equal(summary.stats.catchup_reached_stop_height, true);
});

test('mergeRapidSwapRowsByTxId keeps the latest row for each tx id', () => {
  const rows = mergeRapidSwapRowsByTxId(
    [{ tx_id: 'a', input_estimated_usd: 1 }, { tx_id: 'b', input_estimated_usd: 2 }],
    [{ tx_id: 'a', input_estimated_usd: 3 }],
    [{ tx_id: '' }]
  );

  assert.deepEqual(rows, [
    { tx_id: 'a', input_estimated_usd: 3 },
    { tx_id: 'b', input_estimated_usd: 2 }
  ]);
});
