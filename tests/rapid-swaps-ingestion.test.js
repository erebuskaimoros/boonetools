import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRapidSwapCanonicalScanPlan,
  mergeRapidSwapRowsByTxId,
  summarizeRapidSwapCanonicalScan
} from '../src/lib/rapid-swaps/ingestion.js';

test('buildRapidSwapCanonicalScanPlan loads the saved catch-up cursor when lagging', () => {
  const plan = buildRapidSwapCanonicalScanPlan({
    syncState: {
      last_scanned_height: 5000,
      stats_json: {
        lagging: true,
        catchup_next_page_token: 'cursor-123',
        catchup_stop_below_height: 3200
      }
    },
    overlapBlocks: 1800,
    headMaxPages: 200,
    catchupMaxPages: 80
  });

  assert.deepEqual(plan, {
    head: {
      maxPages: 200,
      stopBelowHeight: 3200
    },
    catchup: {
      maxPages: 80,
      nextPageToken: 'cursor-123',
      stopBelowHeight: 3200
    }
  });
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
