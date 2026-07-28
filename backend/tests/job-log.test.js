import test from 'node:test';
import assert from 'node:assert/strict';

import { createJobCompletionLog, createJobFailureLog } from '../src/lib/job-log.js';

test('completion logs are one bounded summary line without job results', () => {
  const line = createJobCompletionLog('thornode-core-snapshot', 12.6);

  assert.equal(line.includes('\n'), false);
  assert.deepEqual(JSON.parse(line), {
    type: 'job_completed',
    job: 'thornode-core-snapshot',
    duration_ms: 13
  });
});

test('failure logs bound large provider payloads and remain one line', () => {
  const error = new Error(`provider failed: ${'x'.repeat(20_000)}`);
  error.stack = `Error: ${'y'.repeat(20_000)}`;

  const line = createJobFailureLog('analytics-read-models', error, -5);
  const record = JSON.parse(line);

  assert.equal(line.includes('\n'), false);
  assert.equal(record.type, 'job_failed');
  assert.equal(record.job, 'analytics-read-models');
  assert.equal(record.duration_ms, 0);
  assert.ok(record.error.length <= 1_001);
  assert.ok(record.stack.length <= 4_001);
  assert.ok(line.length < 5_500);
});
