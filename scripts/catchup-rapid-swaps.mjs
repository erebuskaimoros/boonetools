#!/usr/bin/env node

/**
 * One-time catch-up: scan recent Midgard swap history, find rapid swaps
 * missing from the local BooneTools Postgres DB, and upsert them.
 */

import { closePool, getClient, query } from '../backend/src/db/pool.js';
import { upsertRapidSwaps } from '../backend/src/db/rapid-swaps-store.js';
import {
  ACTION_PAGE_LIMIT,
  fetchMidgardActions,
  fetchRapidSwapPriceIndex
} from '../src/lib/rapid-swaps/backend.js';
import {
  midgardTimestampToMillis,
  normalizeRapidSwapAction
} from '../src/lib/rapid-swaps/model.js';

function readFlag(name) {
  return process.argv.includes(name);
}

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }

  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    return fallback;
  }

  return value;
}

function readIntArg(name, fallback) {
  const numeric = Number(readArg(name, fallback));
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

const sinceHours = Math.max(1, readIntArg('--since-hours', 48));
const upsertBatch = Math.max(1, readIntArg('--batch', 50));
const dryRun = readFlag('--dry-run');
const targetDate = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

async function fetchExistingTxIds() {
  const ids = new Set();
  const { rows } = await query(
    `select tx_id
     from rapid_swaps
     where action_date >= $1
     order by action_date desc`,
    [targetDate.toISOString()]
  );

  for (const row of rows || []) {
    const txId = String(row.tx_id || '');
    if (txId) {
      ids.add(txId);
    }
  }

  return ids;
}

async function flushPending(client, pendingRows, stats) {
  if (pendingRows.length === 0) {
    return [];
  }

  if (!dryRun) {
    await upsertRapidSwaps(client, pendingRows);
  }

  stats.totalUpserted += pendingRows.length;
  console.log(
    `${dryRun ? 'Would upsert' : 'Upserted'} ${pendingRows.length} rapid swaps ` +
      `(${stats.totalUpserted} total)`
  );

  return [];
}

async function run() {
  console.log(
    `${dryRun ? 'Dry run:' : 'Running:'} scanning rapid swaps since ${targetDate.toISOString()}`
  );

  const [existingIds, priceIndex] = await Promise.all([
    fetchExistingTxIds(),
    fetchRapidSwapPriceIndex()
  ]);

  console.log(`Found ${existingIds.size} existing rapid swaps in DB for this window`);

  const client = await getClient();
  const stats = {
    scannedPages: 0,
    scannedActions: 0,
    foundNew: 0,
    totalUpserted: 0
  };

  let nextPageToken = '';
  let reachedTarget = false;
  let pendingRows = [];
  const missingSample = [];

  try {
    while (!reachedTarget) {
      const payload = await fetchMidgardActions({
        nextPageToken,
        limit: ACTION_PAGE_LIMIT
      });
      const actions = payload.actions || [];

      stats.scannedPages += 1;
      stats.scannedActions += actions.length;

      if (actions.length === 0) {
        break;
      }

      for (const action of actions) {
        const actionMs = midgardTimestampToMillis(action?.date);
        if (actionMs > 0 && actionMs < targetDate.getTime()) {
          reachedTarget = true;
          break;
        }

        const row = normalizeRapidSwapAction(action, {
          observedAt: new Date().toISOString(),
          priceIndex
        });

        const txId = String(row?.tx_id || '');
        if (!txId || existingIds.has(txId)) {
          continue;
        }

        existingIds.add(txId);
        pendingRows.push(row);
        stats.foundNew += 1;

        if (missingSample.length < 20) {
          missingSample.push({
            tx_id: txId,
            action_date: row.action_date,
            action_height: row.action_height,
            source_asset: row.source_asset,
            target_asset: row.target_asset,
            input_estimated_usd: row.input_estimated_usd,
            streaming_count: row.streaming_count,
            blocks_used: row.blocks_used
          });
        }

        if (pendingRows.length >= upsertBatch) {
          pendingRows = await flushPending(client, pendingRows, stats);
        }
      }

      if (!payload.nextPageToken) {
        break;
      }

      nextPageToken = payload.nextPageToken;

      if (stats.scannedPages % 10 === 0) {
        console.log(
          `Scanned ${stats.scannedPages} pages (${stats.scannedActions} actions), ` +
            `found ${stats.foundNew} missing rapid swaps`
        );
      }
    }

    pendingRows = await flushPending(client, pendingRows, stats);
  } finally {
    client.release();
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        targetDate: targetDate.toISOString(),
        scannedPages: stats.scannedPages,
        scannedActions: stats.scannedActions,
        foundNew: stats.foundNew,
        totalUpserted: stats.totalUpserted,
        reachedTarget,
        missingSample
      },
      null,
      2
    )
  );
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
