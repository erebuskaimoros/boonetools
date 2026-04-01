import test from 'node:test';
import assert from 'node:assert/strict';

import { computeLeaderboardRows } from '../src/shared/leaderboard.js';

test('computeLeaderboardRows ranks nodes by total slash delta ascending', () => {
  const result = computeLeaderboardRows({
    churnHeights: [300, 200, 100],
    snapshotsByHeight: {
      200: [
        { node_address: 'thor-node-a', slash_points: 10, status: 'Active' },
        { node_address: 'thor-node-b', slash_points: 20, status: 'Active' }
      ],
      100: [
        { node_address: 'thor-node-a', slash_points: 5, status: 'Active' },
        { node_address: 'thor-node-b', slash_points: 18, status: 'Active' }
      ]
    },
    endSnapshotsByHeight: {
      300: [
        { node_address: 'thor-node-a', slash_points: 12, status: 'Active' },
        { node_address: 'thor-node-b', slash_points: 25, status: 'Active' }
      ],
      200: [
        { node_address: 'thor-node-a', slash_points: 10, status: 'Active' },
        { node_address: 'thor-node-b', slash_points: 20, status: 'Active' }
      ]
    },
    minParticipation: 1,
    maxWindows: 10
  });

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].node_address, 'thor-node-a');
  assert.equal(result.rows[0].total, 7);
  assert.equal(result.rows[1].node_address, 'thor-node-b');
  assert.equal(result.rows[1].total, 7);
});
