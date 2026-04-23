import fs from 'node:fs/promises';

import { getClient, closePool, query } from '../backend/src/db/pool.js';
import { upsertRows } from '../backend/src/db/sql.js';
import {
  calculateBondHistoryRow,
  hasBondHistoryValue
} from '../backend/src/shared/bond-history.js';
import { fetchMidgardActions, fetchMidgardBond } from '../backend/src/shared/midgard.js';
import { fetchThorchain } from '../backend/src/shared/thornode.js';

function parseCli(argv) {
  const options = {
    inputPath: '',
    addresses: [],
    flushSize: 25,
    progressEvery: 10
  };

  for (const arg of argv) {
    if (arg.startsWith('--flush-size=')) {
      const value = Number(arg.slice('--flush-size='.length));
      if (Number.isFinite(value) && value > 0) {
        options.flushSize = Math.trunc(value);
      }
      continue;
    }

    if (arg.startsWith('--progress-every=')) {
      const value = Number(arg.slice('--progress-every='.length));
      if (Number.isFinite(value) && value > 0) {
        options.progressEvery = Math.trunc(value);
      }
      continue;
    }

    if (!options.inputPath) {
      options.inputPath = arg;
      continue;
    }

    options.addresses.push(arg);
  }

  return options;
}

function log(message, details = null) {
  const prefix = `[repair-bond-history ${new Date().toISOString()}]`;
  if (details == null) {
    console.log(`${prefix} ${message}`);
    return;
  }

  console.log(`${prefix} ${message} ${JSON.stringify(details)}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(fn, label, attempts = 3, delayMs = 400) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        log(`retrying ${label}`, {
          attempt,
          attempts,
          error: String(error?.message || error)
        });
        await sleep(delayMs * attempt);
      }
    }
  }
  throw lastError;
}

async function fetchNodeAtHeight(nodeAddress, height) {
  return retry(
    () => fetchThorchain(`/thorchain/node/${nodeAddress}?height=${height}`, { historical: true }),
    `node ${nodeAddress} at ${height}`
  );
}

async function fetchNetworkAtHeight(height) {
  return retry(
    () => fetchThorchain(`/thorchain/network?height=${height}`, { historical: true }),
    `network at ${height}`
  );
}

async function getAllNodeAddresses(bondAddress) {
  const current = await retry(() => fetchMidgardBond(bondAddress), `bond ${bondAddress}`);
  const currentNodes = (current.nodes || [])
    .filter((node) => Number(node.bond) > 1e8)
    .map((node) => node.address);

  const nodeSet = new Set(currentNodes);
  let offset = 0;
  const limit = 50;

  while (true) {
    const data = await retry(
      () => fetchMidgardActions({
        address: bondAddress,
        type: 'bond',
        limit,
        offset
      }),
      `bond actions ${bondAddress} offset ${offset}`
    );
    const actions = data.actions || [];

    for (const action of actions) {
      const nodeAddress = action.metadata?.bond?.nodeAddress;
      if (nodeAddress && nodeAddress.startsWith('thor1')) {
        nodeSet.add(nodeAddress);
      }
    }

    if (actions.length < limit) {
      break;
    }

    offset += actions.length;
  }

  return Array.from(nodeSet);
}

function parseRepairRows(text) {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [bondAddress, churnHeight, churnTimestamp] = line.split('\t');
      return {
        bondAddress,
        churnHeight: Number(churnHeight),
        churnTimestamp: Number(churnTimestamp)
      };
    })
    .filter((row) => row.bondAddress && Number.isFinite(row.churnHeight) && Number.isFinite(row.churnTimestamp));
}

function buildAddressRowMap(rows, onlyAddresses) {
  const rowsByAddress = new Map();

  for (const row of rows) {
    if (onlyAddresses.size > 0 && !onlyAddresses.has(row.bondAddress)) {
      continue;
    }

    const key = `${row.bondAddress}:${row.churnHeight}`;
    if (!rowsByAddress.has(row.bondAddress)) {
      rowsByAddress.set(row.bondAddress, new Map());
    }
    rowsByAddress.get(row.bondAddress).set(key, row);
  }

  for (const [bondAddress, rowMap] of rowsByAddress.entries()) {
    const dedupedRows = Array.from(rowMap.values()).sort((left, right) => right.churnHeight - left.churnHeight);
    rowsByAddress.set(bondAddress, dedupedRows);
  }

  return rowsByAddress;
}

async function flushRecoveredRows(client, rows, summary) {
  if (rows.length === 0) {
    return;
  }

  await upsertRows(client, 'bond_history', rows, {
    conflictColumns: ['bond_address', 'scope', 'churn_height'],
    jsonColumns: ['rates_json']
  });

  summary.recoveredRows += rows.length;
  log('flushed recovered rows', {
    batch: rows.length,
    recoveredRows: summary.recoveredRows
  });
  rows.length = 0;
}

const options = parseCli(process.argv.slice(2));
if (!options.inputPath) {
  console.error('usage: node scripts/repair-bond-history.mjs <repair.tsv> [bond_address ...] [--flush-size=25] [--progress-every=10]');
  process.exit(1);
}

const inputText = await fs.readFile(options.inputPath, 'utf8');
const repairRows = parseRepairRows(inputText);
const onlyAddresses = new Set(options.addresses);
const rowsByAddress = buildAddressRowMap(repairRows, onlyAddresses);
const summary = {
  addresses: rowsByAddress.size,
  attemptedRows: 0,
  skippedExistingRows: 0,
  recoveredRows: 0,
  skippedZeroRows: 0,
  failedRows: 0
};

if (rowsByAddress.size === 0) {
  log('no matching rows to repair', {
    inputRows: repairRows.length,
    filterAddresses: options.addresses
  });
  await closePool().catch(() => {});
  process.exit(0);
}

log('starting repair run', {
  inputPath: options.inputPath,
  addresses: rowsByAddress.size,
  repairRows: Array.from(rowsByAddress.values()).reduce((total, rows) => total + rows.length, 0),
  flushSize: options.flushSize,
  progressEvery: options.progressEvery
});

const targetAddresses = Array.from(rowsByAddress.keys());
const existingPairsResult = await query(
  `select bond_address, churn_height
   from bond_history
   where bond_address = any($1::text[])
     and scope = 'historical'`,
  [targetAddresses]
);
const existingPairs = new Set(
  existingPairsResult.rows.map((row) => `${row.bond_address}:${Number(row.churn_height)}`)
);

const nodeSnapshotCache = new Map();
const networkCache = new Map();
const failedRows = [];
const pendingRows = [];
const client = await getClient();

try {
  for (const [bondAddress, rows] of rowsByAddress.entries()) {
    const addressSummary = {
      rows: rows.length,
      attempted: 0,
      skippedExisting: 0,
      recovered: 0,
      skippedZero: 0,
      failed: 0
    };

    log('starting address', {
      bondAddress,
      rows: rows.length
    });

    let nodeAddresses;
    try {
      nodeAddresses = await getAllNodeAddresses(bondAddress);
      log('resolved node addresses', {
        bondAddress,
        nodeCount: nodeAddresses.length
      });
    } catch (error) {
      addressSummary.failed = rows.length;
      summary.failedRows += rows.length;
      for (const row of rows) {
        failedRows.push({
          bondAddress,
          churnHeight: row.churnHeight,
          reason: `node-addresses: ${String(error?.message || error)}`
        });
      }
      log('failed to resolve node addresses', {
        bondAddress,
        error: String(error?.message || error)
      });
      continue;
    }

    for (const row of rows) {
      summary.attemptedRows += 1;
      addressSummary.attempted += 1;
      const pairKey = `${bondAddress}:${row.churnHeight}`;

      if (existingPairs.has(pairKey)) {
        summary.skippedExistingRows += 1;
        addressSummary.skippedExisting += 1;
      } else {
        try {
          const nodePayloads = [];
          for (const nodeAddress of nodeAddresses) {
            const cacheKey = `${nodeAddress}:${row.churnHeight - 1}`;
            if (!nodeSnapshotCache.has(cacheKey)) {
              nodeSnapshotCache.set(cacheKey, await fetchNodeAtHeight(nodeAddress, row.churnHeight - 1));
            }
            nodePayloads.push(nodeSnapshotCache.get(cacheKey));
          }

          if (!networkCache.has(row.churnHeight)) {
            networkCache.set(row.churnHeight, await fetchNetworkAtHeight(row.churnHeight));
          }

          const computed = calculateBondHistoryRow({
            bondAddress,
            nodePayloads,
            networkData: networkCache.get(row.churnHeight),
            churnHeight: row.churnHeight,
            churnTimestamp: row.churnTimestamp
          });

          if (hasBondHistoryValue(computed)) {
            pendingRows.push({
              bond_address: bondAddress,
              scope: 'historical',
              ...computed
            });
            existingPairs.add(pairKey);
            addressSummary.recovered += 1;
          } else {
            summary.skippedZeroRows += 1;
            addressSummary.skippedZero += 1;
          }
        } catch (error) {
          summary.failedRows += 1;
          addressSummary.failed += 1;
          failedRows.push({
            bondAddress,
            churnHeight: row.churnHeight,
            reason: String(error?.message || error)
          });
          log('failed row', {
            bondAddress,
            churnHeight: row.churnHeight,
            error: String(error?.message || error)
          });
        }
      }

      if (pendingRows.length >= options.flushSize) {
        await flushRecoveredRows(client, pendingRows, summary);
      }

      if (addressSummary.attempted % options.progressEvery === 0 || addressSummary.attempted === rows.length) {
        log('address progress', {
          bondAddress,
          attempted: addressSummary.attempted,
          total: rows.length,
          skippedExisting: addressSummary.skippedExisting,
          recovered: addressSummary.recovered,
          skippedZero: addressSummary.skippedZero,
          failed: addressSummary.failed
        });
      }
    }

    await flushRecoveredRows(client, pendingRows, summary);
    log('finished address', {
      bondAddress,
      ...addressSummary
    });
  }
} finally {
  client.release();
}

log('repair run complete', {
  ...summary,
  failedSample: failedRows.slice(0, 20)
});

await closePool().catch(() => {});
