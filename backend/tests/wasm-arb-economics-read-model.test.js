import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWasmArbEconomicsPayload } from '../src/shared/wasm-arb-economics.js';

async function collectorCoverage(states, pending = 0) {
  const result = await buildWasmArbEconomicsPayload({
    async query(sql) {
      if (sql.includes('from wasm_arb_economics_sync_state')) return { rows: states };
      if (sql.includes('from wasm_arb_economics_blocks')) return { rows: [{ pending }] };
      return { rows: [] };
    }
  }, { generatedAt: '2026-09-02T12:00:00Z' });
  return result.payload.meta.coverage;
}

function archiveStates(target = 27266716) {
  return ['tx', 'block'].map((kind) => ({
    sync_key: `collector-${kind}-search-backfill`, complete: true,
    stats_json: { target_height: target }
  }));
}

test('fee coverage stays incomplete during head catch-up even with an empty block queue', async () => {
  const states = [...archiveStates(), ...['tx', 'block'].map((kind) => ({
    sync_key: `collector-${kind}-search`,
    stats_json: {
      scanned_through_height: 27285515,
      target_height: 27285515,
      latest_height: 27658737,
      max_height: 27658000
    }
  }))];
  const coverage = await collectorCoverage(states);
  assert.equal(coverage.feeBackfillComplete, false);
  assert.equal(coverage.collectorTxHeadComplete, false);
  assert.equal(coverage.collectorBlockHeadComplete, false);
});

test('both discovery heads must cover the newest observed tip before fee coverage is complete', async () => {
  const states = [...archiveStates(), ...['tx', 'block'].map((kind) => ({
    sync_key: `collector-${kind}-search`,
    stats_json: {
      scanned_through_height: 27658737,
      target_height: 27658737,
      latest_height: 27658737
    }
  }))];
  assert.equal((await collectorCoverage(states)).feeBackfillComplete, true);
  assert.equal((await collectorCoverage(states, 1)).feeBackfillComplete, false);

  states[3].stats_json.latest_height = 27658780;
  const coverage = await collectorCoverage(states);
  assert.equal(coverage.feeBackfillComplete, false);
  assert.equal(coverage.collectorTxHeadComplete, false);
});

test('legacy observed matches cannot prove head coverage beyond completed archive', async () => {
  const states = [...archiveStates(), ...['tx', 'block'].map((kind) => ({
    sync_key: `collector-${kind}-search`,
    stats_json: { max_height: 27658000, target_height: 27658737, errors: [] }
  }))];
  assert.equal((await collectorCoverage(states)).feeBackfillComplete, false);
  for (const state of states.slice(0, 2)) state.stats_json.target_height = 27658737;
  assert.equal((await collectorCoverage(states)).feeBackfillComplete, true);
});

test('read model publishes a bounded post-zero monitoring series and retains later markers', async () => {
  const queries = [];
  const responses = [
    { rows: [{
      activation_height: '27181679',
      activation_time: '2026-07-27T14:04:45Z',
      mimir_value: 0,
      previous_mimir_value: 7,
      spread_bps: null,
      previous_spread_bps: null,
      arb_contract: 'arb',
      trade_collector: 'trade',
      base_layer_collector: 'base',
      tc_share: '0.5',
      source: 'verified-chain-event',
      observed_at: '2026-07-27T14:04:45Z',
      metadata_json: { change_kind: 'mimir' }
    }, {
      activation_height: '27184679',
      activation_time: '2026-07-27T19:41:02Z',
      mimir_value: 0,
      previous_mimir_value: 0,
      spread_bps: 3,
      previous_spread_bps: null,
      arb_contract: 'arb',
      trade_collector: 'trade',
      base_layer_collector: 'base',
      tc_share: '0.5',
      source: 'verified-chain-event',
      observed_at: '2026-07-27T19:41:02Z',
      metadata_json: { change_kind: 'spread' }
    }] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [{
      sync_key: 'oracle:backfill',
      cursor_value: '27276350',
      complete: true,
      stats_json: {
        gaps: [{
          height: 27276350,
          block_time: '2026-08-03T12:00:00Z',
          reason: 'empty-oracle-prices'
        }]
      },
      updated_at: '2026-08-03T12:05:00Z'
    }] },
    { rows: [{}] },
    { rows: [] }
  ];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return responses[queries.length - 1];
    }
  };

  const result = await buildWasmArbEconomicsPayload(client, {
    generatedAt: '2026-10-01T00:00:00Z'
  });

  assert.equal(result.payload.schemaVersion, 3);
  assert.equal(result.payload.meta.currentRegime.activationHeight, 27181679);
  assert.equal(result.payload.meta.trackingRegime.activationHeight, 27181679);
  assert.equal(result.payload.meta.trackingStart, '2026-07-27T14:04:45.000Z');
  assert.equal(result.payload.meta.seriesMode, 'post-mimir-zero');
  assert.equal(result.payload.meta.currentSpreadRegime.activationHeight, 27184679);
  assert.equal(result.payload.meta.currentIntervention.activationHeight, 27184679);
  assert.equal(result.payload.meta.coverage.oracleBackfillComplete, true);
  assert.equal(result.payload.meta.coverage.oracleCoverageComplete, false);
  assert.equal(result.payload.meta.coverage.oracleGapCount, 1);
  assert.deepEqual(
    result.payload.meta.interventions.map((row) => row.changeKind),
    ['mimir', 'spread']
  );
  for (const query of queries.slice(1, 5)) {
    assert.deepEqual(query.params, ['2026-07-27T14:04:45.000Z']);
    assert.match(query.sql, /\$1::timestamptz/);
    assert.doesNotMatch(query.sql, /\$2::timestamptz/);
  }
  assert.match(
    queries[3].sql,
    /event_key like 'wasm-arb-rujira-fee:v2:%'\s+and \(block_time >=/s
  );
  assert.match(queries[6].sql, /fetched_version < 2/);
  assert.match(queries[6].sql, /height >= \$1/);
  assert.deepEqual(queries[6].params, [27181679]);
});
