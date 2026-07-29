import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWasmArbEconomicsPayload } from '../src/shared/wasm-arb-economics.js';

test('read model preserves separate archives for the original Mimir and latest spread', async () => {
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
    { rows: [] },
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

  assert.equal(result.payload.meta.currentRegime.activationHeight, 27181679);
  assert.equal(result.payload.meta.currentSpreadRegime.activationHeight, 27184679);
  assert.equal(result.payload.meta.currentIntervention.activationHeight, 27184679);
  assert.deepEqual(
    result.payload.meta.interventions.map((row) => row.changeKind),
    ['mimir', 'spread']
  );
  for (const query of queries.slice(1, 5)) {
    assert.equal(query.params.length, 5);
    assert.match(query.sql, /\$4::timestamptz/);
    assert.match(query.sql, /\$5::timestamptz/);
  }
  assert.match(
    queries[3].sql,
    /event_key like 'wasm-arb-rujira-fee:v2:%'\s+and \(block_time >=/s
  );
  assert.match(queries[6].sql, /fetched_version < 2/);
});
