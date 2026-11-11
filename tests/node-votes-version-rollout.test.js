import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVersionRolloutRows, superMajority } from '../src/lib/node-votes/version-rollout.js';
import { groupActiveVotersByValue } from '../src/lib/node-votes/missing-voters.js';

const node = (index, version, status = 'Active') => ({
  node_address: `thor1node${index}`, node_operator_address: `thor1op${index % 7}`, status, version
});
const fleet = (counts) => Object.entries(counts)
  .flatMap(([version, count], group) => Array.from({ length: count }, (_, index) => node(group * 1000 + index, version)));

test('the supermajority matches THORNode for sizes on and off a multiple of three', () => {
  assert.deepEqual([1, 3, 4, 100, 111, 120].map(superMajority), [1, 2, 3, 67, 74, 80]);
});

test('a patch release in progress becomes one row counting validators short of both thresholds', () => {
  const nodes = [...fleet({ '3.21.4': 32, '3.21.3': 79 }), node(9001, '3.21.4', 'Standby'), node(9002, '3.21.2', 'Whitelisted')];
  const [row, ...rest] = buildVersionRolloutRows({ nodes, networkVersion: '3.21.3' });
  assert.equal(rest.length, 0);
  assert.equal(row.mimir_key, 'VERSION-3.21.4');
  assert.equal(row.vote_kind, 'version');
  assert.deepEqual(row.rollout, { target: '3.21.4', current: '3.21.3', updated: 32, total: 111, remaining: 79,
    superMajority: 74, toSuperMajority: 42, minVersionReached: false });
  assert.deepEqual(row.values.map(({ value, count }) => [value, count]), [['3.21.4', 32], ['3.21.3', 79]]);
  assert.equal(row.active_nodes.length, 111);
  // The vote table's grouped validator panel reads these rows unchanged.
  const groups = groupActiveVotersByValue(row.active_nodes, row.values);
  assert.deepEqual(groups.map((group) => [group.value, group.count, group.is_missing]),
    [['3.21.3', 79, false], ['3.21.4', 32, false]]);
  assert.match(groups[0].voters[0].operator_address, /^thor1op/);
});

test('nodes on a later release count toward an earlier one, as THORNode counts them', () => {
  const rows = buildVersionRolloutRows({ nodes: fleet({ '3.21.5': 10, '3.21.4': 70, '3.21.3': 31 }), networkVersion: '3.21.3' });
  assert.deepEqual(rows.map((row) => [row.mimir_key, row.rollout.updated, row.rollout.minVersionReached, row.rollout.remaining]), [
    ['VERSION-3.21.5', 10, false, 101],
    ['VERSION-3.21.4', 80, true, 31]
  ]);
  // 3.21.10 is later than 3.21.9: versions compare by number, not as text.
  const numeric = buildVersionRolloutRows({ nodes: fleet({ '3.21.10': 2, '3.21.9': 4 }), networkVersion: '3.21.9' });
  assert.deepEqual(numeric.map((row) => [row.mimir_key, row.rollout.updated]), [['VERSION-3.21.10', 2]]);
});

test('no row is shown when nothing is rolling out or the inputs cannot be trusted', () => {
  assert.deepEqual(buildVersionRolloutRows({ nodes: fleet({ '3.21.4': 111 }), networkVersion: '3.21.4' }), []);
  assert.deepEqual(buildVersionRolloutRows({ nodes: fleet({ '3.21.3': 100, '3.21.2': 11 }), networkVersion: '3.21.3' }), []);
  assert.deepEqual(buildVersionRolloutRows({ nodes: fleet({ '3.21.4': 5 }), networkVersion: '' }), []);
  assert.deepEqual(buildVersionRolloutRows({ nodes: [], networkVersion: '3.21.3' }), []);
  assert.deepEqual(buildVersionRolloutRows(), []);
  // A node reporting no usable version is listed but never counted as updated.
  const [row] = buildVersionRolloutRows({ nodes: [...fleet({ '3.21.4': 2, '3.21.3': 2 }), node(77, '')], networkVersion: '3.21.3' });
  assert.equal(row.rollout.updated, 2);
  assert.deepEqual(row.values.map(({ value, count }) => [value, count]), [['3.21.4', 2], ['3.21.3', 2], ['unknown', 1]]);
});
