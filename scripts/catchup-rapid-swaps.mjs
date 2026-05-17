#!/usr/bin/env node

/**
 * One-time catch-up: scan recent Midgard swap history, find rapid swaps
 * missing from the local BooneTools Postgres DB, and upsert them.
 */

import { closePool, getClient, query } from '../backend/src/db/pool.js';
import { upsertRapidSwaps } from '../backend/src/db/rapid-swaps-store.js';
import fs from 'node:fs';
import {
  ACTION_PAGE_LIMIT,
  fetchMidgardActions,
  fetchRapidSwapPriceIndex,
  getRapidSwapRateLimitCooldownMs,
  isRapidSwapRateLimitError
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

function readDateArg(name) {
  const value = String(readArg(name, '') || '').trim();
  if (!value) {
    return null;
  }

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00.000Z`
    : value;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return date;
}

const sinceHours = Math.max(1, readIntArg('--since-hours', 48));
const upsertBatch = Math.max(1, readIntArg('--batch', 50));
const delayMs = Math.max(0, readIntArg('--delay-ms', 5000));
const maxPages = Math.max(0, readIntArg('--max-pages', 0));
const initialPageToken = String(readArg('--page-token', '') || '');
const dryRun = readFlag('--dry-run');
const sleepOnRateLimit = readFlag('--sleep-on-rate-limit');
const stateFile = String(readArg('--state-file', '') || '').trim();
const fromDateArg = readDateArg('--from-date') || readDateArg('--from');
const toDateArg = readDateArg('--to-date') || readDateArg('--to');
const targetDate = fromDateArg || new Date(Date.now() - sinceHours * 60 * 60 * 1000);
const endDate = toDateArg || null;

if (endDate && endDate <= targetDate) {
  throw new Error('--to-date must be later than --from-date');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadState() {
  if (!stateFile || !fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read state file ${stateFile}: ${error.message}`);
  }
}

function writeState(patch) {
  if (!stateFile) {
    return;
  }

  const state = {
    targetDate: targetDate.toISOString(),
    endDate: endDate?.toISOString() || '',
    updatedAt: new Date().toISOString(),
    ...patch
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

async function fetchExistingTxIds() {
  const ids = new Set();
  const params = [targetDate.toISOString()];
  let endPredicate = '';
  if (endDate) {
    params.push(endDate.toISOString());
    endPredicate = ` and action_date < $${params.length}`;
  }

  const { rows } = await query(
    `select tx_id
     from rapid_swaps
     where action_date >= $1${endPredicate}
     order by action_date desc`,
    params
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
    `${dryRun ? 'Dry run:' : 'Running:'} scanning rapid swaps ` +
      `${endDate ? `from ${targetDate.toISOString()} to ${endDate.toISOString()}` : `since ${targetDate.toISOString()}`}`
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
    totalUpserted: 0,
    rateLimited: false,
    rateLimitedUntil: '',
    nextPageToken: initialPageToken
  };

  let nextPageToken = initialPageToken;
  const savedState = loadState();
  if (!nextPageToken && savedState?.nextPageToken && !savedState?.completed) {
    const savedTarget = String(savedState.targetDate || '');
    const savedEnd = String(savedState.endDate || '');
    if (savedTarget === targetDate.toISOString() && savedEnd === (endDate?.toISOString() || '')) {
      nextPageToken = String(savedState.nextPageToken || '');
      stats.nextPageToken = nextPageToken;
      console.log(`Resuming from state file ${stateFile}: nextPageToken=${nextPageToken}`);
    }
  }

  const initialTimestamp = endDate ? Math.floor(endDate.getTime() / 1000) : 0;
  let reachedTarget = false;
  let hitPageBudget = false;
  let pendingRows = [];
  const missingSample = [];

  try {
    while (!reachedTarget) {
      if (maxPages > 0 && stats.scannedPages >= maxPages) {
        hitPageBudget = true;
        break;
      }

      let payload;
      try {
        payload = await fetchMidgardActions({
          nextPageToken,
          timestamp: !nextPageToken && initialTimestamp > 0 ? initialTimestamp : 0,
          limit: ACTION_PAGE_LIMIT
        });
      } catch (error) {
        if (isRapidSwapRateLimitError(error)) {
          const cooldownMs = getRapidSwapRateLimitCooldownMs(error, 60 * 60 * 1000);
          stats.rateLimited = true;
          stats.rateLimitedUntil = new Date(Date.now() + cooldownMs).toISOString();
          console.log(`Rate limited after ${stats.scannedPages} pages; retry after ${stats.rateLimitedUntil}`);
          writeState({
            completed: false,
            rateLimited: true,
            rateLimitedUntil: stats.rateLimitedUntil,
            nextPageToken,
            scannedPages: stats.scannedPages,
            scannedActions: stats.scannedActions,
            foundNew: stats.foundNew,
            totalUpserted: stats.totalUpserted
          });

          if (sleepOnRateLimit) {
            await sleep(cooldownMs + 5000);
            stats.rateLimited = false;
            stats.rateLimitedUntil = '';
            continue;
          }

          break;
        }

        throw error;
      }

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

        if (endDate && actionMs > 0 && actionMs >= endDate.getTime()) {
          continue;
        }

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
      stats.nextPageToken = nextPageToken;
      writeState({
        completed: false,
        rateLimited: false,
        nextPageToken,
        scannedPages: stats.scannedPages,
        scannedActions: stats.scannedActions,
        foundNew: stats.foundNew,
        totalUpserted: stats.totalUpserted
      });

      console.log(
        `Scanned ${stats.scannedPages} pages (${stats.scannedActions} actions), ` +
          `found ${stats.foundNew} missing rapid swaps, nextPageToken=${nextPageToken || '<none>'}`
      );

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }

    pendingRows = await flushPending(client, pendingRows, stats);
    writeState({
      completed: reachedTarget || (!hitPageBudget && !stats.rateLimited && !nextPageToken),
      reachedTarget,
      hitPageBudget,
      rateLimited: stats.rateLimited,
      rateLimitedUntil: stats.rateLimitedUntil,
      nextPageToken: stats.nextPageToken,
      scannedPages: stats.scannedPages,
      scannedActions: stats.scannedActions,
      foundNew: stats.foundNew,
      totalUpserted: stats.totalUpserted
    });
  } finally {
    client.release();
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        targetDate: targetDate.toISOString(),
        endDate: endDate?.toISOString() || '',
        scannedPages: stats.scannedPages,
        scannedActions: stats.scannedActions,
        foundNew: stats.foundNew,
        totalUpserted: stats.totalUpserted,
        reachedTarget,
        hitPageBudget,
        rateLimited: stats.rateLimited,
        rateLimitedUntil: stats.rateLimitedUntil,
        nextPageToken: stats.nextPageToken,
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
