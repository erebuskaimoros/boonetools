import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backfillBlockProductionRange,
  buildBlockProductionBuckets,
  parseBlockProductionHead,
  parseBlockRangeHeaders,
  summarizeBlockRange
} from '../src/shared/block-production.js';

test('parseBlockProductionHead reads the canonical RPC sync head', () => {
  assert.deepEqual(parseBlockProductionHead({
    result: {
      sync_info: {
        latest_block_height: '12345',
        latest_block_time: '2026-07-21T12:00:00.000Z'
      }
    }
  }), {
    height: 12345,
    blockTime: '2026-07-21T12:00:00.000Z'
  });
});

test('summarizeBlockRange calculates seconds per produced block', () => {
  const sample = summarizeBlockRange({
    result: {
      block_metas: [
        { header: { height: '102', time: '2026-07-21T12:00:12.600Z' } },
        { header: { height: '100', time: '2026-07-21T12:00:00.000Z' } },
        { header: { height: '101', time: '2026-07-21T12:00:06.100Z' } }
      ]
    }
  });

  assert.equal(sample.startHeight, 100);
  assert.equal(sample.endHeight, 102);
  assert.equal(sample.blockCount, 2);
  assert.equal(sample.secondsPerBlock, 6.3);
  assert.equal(sample.sampleTime, '2026-07-21T12:00:12.600Z');
});

test('summarizeBlockRange rejects incomplete or non-progressing ranges', () => {
  assert.equal(summarizeBlockRange({ result: { block_metas: [] } }), null);
  assert.equal(summarizeBlockRange({
    result: {
      block_metas: [{ header: { height: '100', time: '2026-07-21T12:00:00Z' } }]
    }
  }), null);
});

test('parseBlockRangeHeaders normalizes and sorts canonical headers', () => {
  assert.deepEqual(parseBlockRangeHeaders({
    result: {
      block_metas: [
        { header: { height: '102', time: '2026-07-21T12:00:12.600Z' } },
        { header: { height: '100', time: '2026-07-21T12:00:00.000Z' } },
        { header: { height: 'bad', time: '2026-07-21T12:00:06.100Z' } }
      ]
    }
  }), [
    { height: 100, blockTime: '2026-07-21T12:00:00.000Z' },
    { height: 102, blockTime: '2026-07-21T12:00:12.600Z' }
  ]);
});

test('buildBlockProductionBuckets calculates aligned five-minute samples', () => {
  const samples = buildBlockProductionBuckets([
    { height: 100, blockTime: '2026-07-21T12:00:01.000Z' },
    { height: 101, blockTime: '2026-07-21T12:00:07.000Z' },
    { height: 102, blockTime: '2026-07-21T12:04:55.000Z' },
    { height: 103, blockTime: '2026-07-21T12:05:02.000Z' },
    { height: 104, blockTime: '2026-07-21T12:09:58.000Z' }
  ]);

  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((sample) => ({
    startHeight: sample.startHeight,
    endHeight: sample.endHeight,
    blockCount: sample.blockCount,
    secondsPerBlock: sample.secondsPerBlock,
    source: sample.source
  })), [
    { startHeight: 100, endHeight: 102, blockCount: 2, secondsPerBlock: 147, source: 'rpc-5m-backfill' },
    { startHeight: 103, endHeight: 104, blockCount: 1, secondsPerBlock: 296, source: 'rpc-5m-backfill' }
  ]);
});

test('backfillBlockProductionRange pages every header and replaces overlapping hourly samples', async () => {
  const queries = [];
  const fetchRpc = async (path, { minHeight, maxHeight }) => ({
    result: {
      block_metas: Array.from({ length: maxHeight - minHeight + 1 }, (_, index) => {
        const height = minHeight + index;
        return {
          header: {
            height: String(height),
            time: new Date(Date.parse('2026-07-21T12:00:00.000Z') + ((height - 100) * 6_000)).toISOString()
          }
        };
      })
    }
  });
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rowCount: sql.trim().startsWith('delete') ? 2 : 1 };
    }
  };

  const result = await backfillBlockProductionRange(client, {
    startHeight: 100,
    endHeight: 124,
    fetchRpc
  });

  assert.equal(result.headers, 25);
  assert.equal(result.samples, 1);
  assert.equal(result.removedHourlySamples, 2);
  assert.equal(queries.filter(({ sql }) => sql.trim().startsWith('delete')).length, 1);
  assert.equal(queries.filter(({ sql }) => sql.trim().startsWith('insert')).length, 1);
});
