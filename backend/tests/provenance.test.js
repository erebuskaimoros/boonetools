import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalNodeVoteKey,
  canonicalReservePaymentKey,
  choosePreferredSource,
  enrichEventRows,
  eventProvenanceFields,
  selectPreferredEventRows
} from '../src/lib/provenance.js';

test('source preference retains canonical Dune observations', () => {
  assert.equal(choosePreferredSource('midgard', 'dune'), 'dune');
  assert.equal(choosePreferredSource('dune', 'ws'), 'dune');
  assert.equal(choosePreferredSource('', 'rpc'), 'rpc');
});

test('canonical keys are independent of provider-specific event keys', () => {
  const vote = {
    tx_id: 'ABC',
    height: 12,
    event_index: 2,
    node_address: 'thor1node',
    mimir_key: 'HALTTRADING',
    vote_value: '1'
  };
  assert.equal(canonicalNodeVoteKey({ ...vote, event_key: 'rpc-key' }), canonicalNodeVoteKey({
    ...vote,
    event_key: 'dune-key',
    node_address: 'provider-disagrees',
    mimir_key: 'DIFFERENT',
    vote_value: '999'
  }));

  const payment = {
    height: 13,
    tx_id: 'DEF',
    amount_base: '100',
    sender: 'thor1sender',
    recipient: 'thor1reserve',
    memo: 'RESERVE'
  };
  assert.equal(canonicalReservePaymentKey({ ...payment, event_key: 'rpc' }), canonicalReservePaymentKey({
    ...payment,
    event_key: 'dune'
  }));
});

test('eventProvenanceFields emits explicit versioned timestamps', () => {
  assert.deepEqual(eventProvenanceFields({
    canonicalKey: 'tx',
    source: 'midgard',
    observedAt: '2026-07-17T12:00:00Z'
  }), {
    canonical_key: 'tx',
    preferred_source: 'midgard',
    first_seen_at: '2026-07-17T12:00:00.000Z',
    last_seen_at: '2026-07-17T12:00:00.000Z',
    schema_version: 1
  });
});

test('enrichEventRows retains each observation source for atomic upsert selection', async () => {
  const client = {
    query: async () => { throw new Error('enrichment must not perform read-before-write source selection'); }
  };
  const rows = await enrichEventRows(client, {
    table: 'rapid_swaps',
    rows: [{ tx_id: 'tx', observed_at: '2026-07-17T12:00:00Z', raw_action: {} }],
    canonicalKey: (row) => row.tx_id,
    source: () => 'midgard',
    observedAt: (row) => row.observed_at
  });
  assert.equal(rows[0].preferred_source, 'midgard');
});

test('selectPreferredEventRows chooses the strongest and newest canonical observation', () => {
  const selected = selectPreferredEventRows([
    { canonical_key: 'tx', preferred_source: 'midgard', last_seen_at: '2026-07-17T12:03:00Z' },
    { canonical_key: 'tx', preferred_source: 'dune', last_seen_at: '2026-07-17T12:01:00Z' },
    { canonical_key: 'other', preferred_source: 'ws', last_seen_at: '2026-07-17T12:00:00Z' },
    { canonical_key: 'other', preferred_source: 'ws', last_seen_at: '2026-07-17T12:02:00Z' }
  ]);

  assert.equal(selected.find((row) => row.canonical_key === 'tx').preferred_source, 'dune');
  assert.equal(selected.find((row) => row.canonical_key === 'other').last_seen_at, '2026-07-17T12:02:00Z');
});
