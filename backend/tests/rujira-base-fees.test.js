import assert from 'node:assert/strict';
import test from 'node:test';

function event(type, attrs) {
  return {
    type,
    attributes: Object.entries(attrs).map(([key, value]) => ({
      key,
      value: String(value)
    }))
  };
}

test('parseRujiraBaseFeeBlock counts only memo-matched Rujira THORChain swap fees', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    RUJIRA_THORCHAIN_SWAP_CONTRACT,
    RUJI_SWAP_REVENUE_COLLECTOR,
    parseRujiraBaseFeeBlock
  } = await import('../src/shared/rujira-base-fees.js');

  const block = {
    result: {
      txs_results: [
        {
          events: [
            event('wasm-rujira-fin/trade', {
              _contract_address: 'thor1fincontract',
              offer: '100000000',
              bid: '200000000',
              side: 'quote'
            }),
            event('wasm-rujira-thorchain-swap/swap', {
              _contract_address: RUJIRA_THORCHAIN_SWAP_CONTRACT,
              amount: '100000000rune',
              memo: '=:BTC.BTC:thor1dest:0/1/1'
            })
          ]
        },
        {
          events: [
            event('wasm-rujira-revenue/run', {
              _contract_address: RUJI_SWAP_REVENUE_COLLECTOR,
              denom: 'rune'
            }),
            event('wasm-rujira-thorchain-swap/swap', {
              _contract_address: RUJIRA_THORCHAIN_SWAP_CONTRACT,
              amount: '200000000rune',
              memo: '=:ETH.ETH:thor1dest:0/1/1'
            })
          ]
        }
      ],
      finalize_block_events: [
        event('swap', {
          id: 'unrelated',
          from: 'thor1notrujira',
          to: 'thor1dest',
          pool: 'BTC.BTC',
          chain: 'THOR',
          coin: '100000000 THOR.RUNE',
          memo: '=:BTC.BTC:thor1dest:0/1/1',
          liquidity_fee_in_rune: '999'
        }),
        event('swap', {
          id: 'included',
          from: RUJIRA_THORCHAIN_SWAP_CONTRACT,
          to: 'thor1dest',
          pool: 'BTC.BTC',
          chain: 'THOR',
          coin: '100000000 THOR.RUNE',
          memo: '=:BTC.BTC:thor1dest:0/1/1',
          liquidity_fee_in_rune: '12345'
        }),
        event('swap', {
          id: 'excluded',
          from: RUJIRA_THORCHAIN_SWAP_CONTRACT,
          to: 'thor1dest',
          pool: 'ETH.ETH',
          chain: 'THOR',
          coin: '200000000 THOR.RUNE',
          memo: '=:ETH.ETH:thor1dest:0/1/1',
          liquidity_fee_in_rune: '67890'
        }),
        event('swap', {
          id: 'not-emitted-by-rujira',
          from: RUJIRA_THORCHAIN_SWAP_CONTRACT,
          to: 'thor1dest',
          pool: 'DOGE.DOGE',
          chain: 'THOR',
          coin: '300000000 THOR.RUNE',
          memo: '=:DOGE.DOGE:thor1dest:0/1/1',
          liquidity_fee_in_rune: '11111'
        })
      ]
    }
  };

  const parsed = parseRujiraBaseFeeBlock(123, block, {
    blockTime: '2026-05-18T00:00:00.000Z'
  });

  assert.equal(parsed.events.length, 2);

  const included = parsed.events.find((row) => row.swap_id === 'included');
  assert.equal(included.included, true);
  assert.equal(included.classification, 'fin_base_layer_execution');
  assert.equal(included.liquidity_fee_rune, 0.00012345);

  const excluded = parsed.events.find((row) => row.swap_id === 'excluded');
  assert.equal(excluded.included, false);
  assert.equal(excluded.classification, 'ruji_swap_revenue_excluded');

  assert.equal(parsed.scan.final_rujira_swap_count, 3);
  assert.equal(parsed.scan.matched_event_count, 2);
  assert.equal(parsed.scan.included_event_count, 1);
  assert.equal(parsed.scan.excluded_event_count, 1);
});

test('saveParsedRujiraBaseFeeBlock skips empty websocket blocks by default', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { saveParsedRujiraBaseFeeBlock } = await import('../src/shared/rujira-base-fees.js');
  const queries = [];
  const client = {
    query: async (...args) => {
      queries.push(args);
      return { rows: [], rowCount: 0 };
    }
  };

  const parsed = await saveParsedRujiraBaseFeeBlock(client, 456, {
    result: {
      txs_results: [],
      finalize_block_events: []
    }
  }, {
    blockTime: '2026-05-18T00:00:00.000Z',
    source: 'ws'
  });

  assert.equal(parsed.events.length, 0);
  assert.equal(queries.length, 0);
});

test('buildRujiraBaseFeeRowsFromDune normalizes Dune generated-fee rows', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { buildRujiraBaseFeeRowsFromDune } = await import('../src/shared/rujira-base-fees.js');

  const [row] = buildRujiraBaseFeeRowsFromDune([{
    event_key: 'dune-row-1',
    height: 25999025,
    block_time: '2026-05-01 23:11:49.000 UTC',
    swap_id: '5ec55ce39298d90299b955df0b7149da389a9ce1ae33d9bbf75414b9c04e7ddc',
    pool: 'THOR.RUJI',
    chain: 'THOR',
    from_address: 'thor1swap',
    to_address: 'thor1dest',
    coin: '16.999151 THOR.RUNE',
    memo: '=:THOR.RUJI:thor1dest:0/1/1',
    liquidity_fee_base: 1699960,
    liquidity_fee_rune: 0.0169996,
    rune_price_usd: 0.5084920729,
    liquidity_fee_usd: 0.0086441618,
    classification: 'fin_base_layer_execution',
    included: true,
    source_contract: 'thor1fin',
    source_label: 'RUJI Trade / FIN thor1fin...',
    source_denom: '',
    source: 'dune'
  }]);

  assert.equal(row.event_key, 'dune-row-1');
  assert.equal(row.height, 25999025);
  assert.equal(row.block_time, '2026-05-01T23:11:49.000+00:00');
  assert.equal(row.swap_id, '5EC55CE39298D90299B955DF0B7149DA389A9CE1AE33D9BBF75414B9C04E7DDC');
  assert.equal(row.included, true);
  assert.equal(row.classification, 'fin_base_layer_execution');
  assert.equal(row.liquidity_fee_base, '1699960');
  assert.equal(row.raw_event.source, 'dune');
  assert.equal(row.context_json.query_id, '7620091');
});
