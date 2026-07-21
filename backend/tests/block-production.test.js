import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseBlockProductionHead,
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
