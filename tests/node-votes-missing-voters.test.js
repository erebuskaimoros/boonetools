import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findMissingVoters,
  groupActiveVotersByValue
} from '../src/lib/node-votes/missing-voters.js';

test('groupActiveVotersByValue groups every active node by current value with non-voters last', () => {
  const activeNodes = [
    { node_address: 'thor-node-1', operator_address: 'thor-operator-1111' },
    { node_address: 'thor-node-2', operator_address: 'thor-operator-2222' },
    { node_address: 'thor-node-3', operator_address: 'thor-operator-3333' },
    { node_address: 'thor-node-4', operator_address: 'thor-operator-4444' }
  ];
  const voteValues = [
    { value: '1', nodes: ['thor-node-1', 'thor-node-2'] },
    { value: '2', nodes: ['thor-node-3'] }
  ];

  assert.deepEqual(groupActiveVotersByValue(activeNodes, voteValues), [
    { value: '1', count: 2, voters: activeNodes.slice(0, 2), is_missing: false },
    { value: '2', count: 1, voters: [activeNodes[2]], is_missing: false },
    { value: null, count: 1, voters: [activeNodes[3]], is_missing: true }
  ]);
});

test('groupActiveVotersByValue remains complete after consensus passes', () => {
  const activeNodes = Array.from({ length: 14 }, (_, index) => ({
    node_address: `thor-node-${index + 1}`,
    operator_address: `thor-operator-${index + 1}`
  }));
  const voteValues = [{
    value: '1',
    nodes: activeNodes.map((node) => node.node_address)
  }];

  const groups = groupActiveVotersByValue(activeNodes, voteValues);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 14);
  assert.deepEqual(groups[0].voters, activeNodes);
});

test('findMissingVoters excludes active nodes voting for any current value', () => {
  const activeNodes = [
    { node_address: 'thor-node-1', operator_address: 'thor-operator-1111' },
    { node_address: 'thor-node-2', operator_address: 'thor-operator-2222' },
    { node_address: 'thor-node-3', operator_address: 'thor-operator-3333' }
  ];
  const voteValues = [
    { value: '1', nodes: ['thor-node-1'] },
    { value: '2', nodes: ['thor-node-2'] }
  ];

  assert.deepEqual(findMissingVoters(activeNodes, voteValues), [activeNodes[2]]);
});

test('findMissingVoters returns every active node when a key has no current votes', () => {
  const activeNodes = [
    { node_address: 'thor-node-1', operator_address: 'thor-operator-1111' },
    { node_address: 'thor-node-2', operator_address: 'thor-operator-2222' }
  ];

  assert.deepEqual(findMissingVoters(activeNodes, []), activeNodes);
});

test('findMissingVoters prefers complete detail stances over compact value samples', () => {
  const activeNodes = Array.from({ length: 14 }, (_, index) => ({
    node_address: `thor-node-${index + 1}`,
    operator_address: `thor-operator-${index + 1}`
  }));
  const compactValues = [{ value: '1', nodes: activeNodes.slice(0, 12).map((node) => node.node_address) }];
  const nodeVotes = activeNodes.map((node) => ({
    node_address: node.node_address,
    vote_value: '1',
    vote_removed: false
  }));

  assert.deepEqual(findMissingVoters(activeNodes, compactValues, nodeVotes), []);
});
