import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeNodeVotesDashboard } from '../src/lib/node-votes/dashboard-state.js';

test('summary refresh preserves already-loaded vote and node drill-down rows', () => {
  const current = {
    generated_at: '2026-08-14T13:30:00Z',
    stats: { total_vote_events: 100 },
    by_vote: [{
      mimir_key: 'ADR029',
      leader_count: 63,
      node_votes: [{ node_address: 'thor1node', vote_value: '1' }],
      vote_history: [{ event_key: 'vote-1', height: 27_424_700 }],
      effective_history: [{ effective_value: '1', height: 27_424_700 }],
      detail_pagination: { has_next: true, next_cursor: 'older-votes' }
    }],
    by_node: [{
      node_address: 'thor1node',
      unique_keys: 4,
      vote_history: [{ event_key: 'vote-1', mimir_key: 'ADR029' }],
      detail_pagination: { has_next: true, next_cursor: 'older-node-votes' }
    }]
  };
  const refreshedSummary = {
    generated_at: '2026-08-14T13:31:00Z',
    stats: { total_vote_events: 101 },
    by_vote: [{
      mimir_key: 'ADR029',
      leader_count: 64,
      effective_history: [{ effective_value: '1', height: 27_424_771 }]
    }],
    by_node: [{
      node_address: 'thor1node',
      unique_keys: 5
    }]
  };

  const merged = mergeNodeVotesDashboard(current, refreshedSummary);

  assert.equal(merged.generated_at, refreshedSummary.generated_at);
  assert.equal(merged.stats.total_vote_events, 101);
  assert.equal(merged.by_vote[0].leader_count, 64);
  assert.deepEqual(merged.by_vote[0].effective_history, refreshedSummary.by_vote[0].effective_history);
  assert.deepEqual(merged.by_vote[0].node_votes, current.by_vote[0].node_votes);
  assert.deepEqual(merged.by_vote[0].vote_history, current.by_vote[0].vote_history);
  assert.deepEqual(merged.by_vote[0].detail_pagination, current.by_vote[0].detail_pagination);
  assert.equal(merged.by_node[0].unique_keys, 5);
  assert.deepEqual(merged.by_node[0].vote_history, current.by_node[0].vote_history);
  assert.deepEqual(merged.by_node[0].detail_pagination, current.by_node[0].detail_pagination);
});

test('summary refresh does not resurrect drill-down state for rows no longer returned', () => {
  const merged = mergeNodeVotesDashboard({
    by_vote: [{ mimir_key: 'REMOVED', vote_history: [{ event_key: 'old' }] }],
    by_node: [{ node_address: 'thor1old', vote_history: [{ event_key: 'old' }] }]
  }, {
    by_vote: [{ mimir_key: 'NEW' }],
    by_node: [{ node_address: 'thor1new' }]
  });

  assert.deepEqual(merged.by_vote, [{ mimir_key: 'NEW' }]);
  assert.deepEqual(merged.by_node, [{ node_address: 'thor1new' }]);
});
