import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIDGARD_ACTION_PAGE_LIMIT,
  RAPID_MIDGARD_VALIDATION_OPTIONS,
  isMidgardPayloadInvalid
} from '../shared/midgard-policy.js';

const rapidInvalid = (path, payload) => isMidgardPayloadInvalid(path, payload, RAPID_MIDGARD_VALIDATION_OPTIONS);
const actions = (count) => Array.from({ length: count }, (_, height) => ({ height: String(height) }));

test('general and Rapid history profiles retain their distinct empty-history evidence', () => {
  const endpoint = '/history/swaps?interval=day';
  for (const meta of [{}, { startTime: '2', endTime: '2' }, { startTime: '3', endTime: '2' }]) {
    const payload = { intervals: [], meta };
    assert.equal(isMidgardPayloadInvalid(endpoint, payload), true);
    assert.equal(rapidInvalid(endpoint, payload), false);
  }
  for (const validate of [isMidgardPayloadInvalid, rapidInvalid]) {
    assert.equal(validate(endpoint, { intervals: [], meta: { startTime: '1', endTime: '2' } }), true);
    assert.equal(validate(endpoint, { intervals: [], meta: null }), false);
    assert.equal(validate(endpoint, { intervals: [{ startTime: '1' }], meta: {} }), false);
    assert.equal(validate('/history/swaps', { intervals: [], meta: { startTime: '1', endTime: '2' } }), false);
    // Endpoint-specific shape validators remain the callers' responsibility.
    assert.equal(validate(endpoint, {}), false);
  }
});

test('both profiles retain sub-50 response-limit checks without changing the boundary', () => {
  assert.equal(MIDGARD_ACTION_PAGE_LIMIT, 50);
  for (const validate of [isMidgardPayloadInvalid, rapidInvalid]) {
    assert.equal(validate('/actions?limit=1', { actions: actions(2) }), true);
    assert.equal(validate('/actions?limit=49', { actions: actions(50) }), true);
    assert.equal(validate('/actions?limit=49', { actions: actions(49) }), false);
    assert.equal(validate('/actions?limit=50', { actions: actions(51) }), false);
    assert.equal(validate('/actions?limit=100', { actions: actions(101) }), false);
    assert.equal(validate('/pools?limit=1', { actions: actions(2) }), false);
  }
});

test('action-limit normalization remains explicit for the Rapid profile', () => {
  for (const endpoint of ['/actions', '/actions?limit=0', '/actions?limit=-1']) {
    assert.equal(isMidgardPayloadInvalid(endpoint, { actions: actions(2) }), false);
    assert.equal(rapidInvalid(endpoint, { actions: actions(2) }), true);
  }
  assert.equal(isMidgardPayloadInvalid('/actions?limit=invalid', { actions: actions(51) }), false);
  assert.equal(rapidInvalid('/actions?limit=invalid', { actions: actions(51) }), false);
});

test('Rapid txid evidence accepts matching input or output IDs case-insensitively', () => {
  const endpoint = '/actions?limit=50&txid=target-tx';
  assert.equal(rapidInvalid(endpoint, { actions: [{ in: [{ txID: 'wrong-tx' }] }] }), true);
  assert.equal(rapidInvalid(endpoint, { actions: [{ in: [{ txID: 'TARGET-TX' }] }] }), false);
  assert.equal(rapidInvalid(endpoint, { actions: [{ out: [{ txID: 'Target-Tx' }] }] }), false);
  assert.equal(rapidInvalid(endpoint, { actions: [null, { out: [{ txID: 'target-tx' }] }] }), false);
  assert.equal(rapidInvalid(endpoint, { actions: [] }), false);
  assert.equal(isMidgardPayloadInvalid(endpoint, { actions: [{ in: [{ txID: 'wrong-tx' }] }] }), false);
});

test('Rapid cursor checks reject a repeated token even for an empty action page', () => {
  const endpoint = '/actions?limit=50&nextPageToken=cursor-2';
  for (const page of [[], actions(1)]) {
    assert.equal(rapidInvalid(endpoint, { actions: page, meta: { nextPageToken: 'cursor-2' } }), true);
    assert.equal(rapidInvalid(endpoint, { actions: page, meta: { nextPageToken: 'cursor-3' } }), false);
    assert.equal(rapidInvalid(endpoint, { actions: page, meta: { nextPageToken: '' } }), false);
  }
  assert.equal(isMidgardPayloadInvalid(endpoint, { actions: [], meta: { nextPageToken: 'cursor-2' } }), false);
});

test('Rapid fromHeight checks require at least one action reaching the requested floor', () => {
  const endpoint = '/actions?limit=50&fromHeight=100';
  assert.equal(rapidInvalid(endpoint, { actions: [{ height: '99' }] }), true);
  assert.equal(rapidInvalid(endpoint, { actions: [{ height: '99' }, { height: '100' }] }), false);
  assert.equal(rapidInvalid(endpoint, { actions: [{ height: '101' }] }), false);
  assert.equal(rapidInvalid(endpoint, { actions: [{ height: 'invalid' }] }), true);
  assert.equal(rapidInvalid(endpoint, { actions: [] }), false);
  assert.equal(isMidgardPayloadInvalid(endpoint, { actions: [{ height: '99' }] }), false);
});
