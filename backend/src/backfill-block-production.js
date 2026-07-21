import { closePool, getClient } from './db/pool.js';
import { backfillBlockProductionRange } from './shared/block-production.js';

const startHeight = Number(process.argv[2]);
const endHeight = Number(process.argv[3]);

if (!Number.isInteger(startHeight) || !Number.isInteger(endHeight) || startHeight <= 0 || endHeight <= startHeight) {
  console.error('Usage: node src/backfill-block-production.js <start-height> <end-height>');
  process.exit(1);
}

const client = await getClient();
try {
  await client.query('begin');
  const result = await backfillBlockProductionRange(client, { startHeight, endHeight });
  await client.query('commit');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await client.query('rollback').catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  client.release();
  await closePool();
}
