import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('parseRujiraReservePaymentBlock reads Base Layer collector transfer events', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    BASE_LAYER_REVENUE_COLLECTOR,
    TC_RESERVE_MODULE,
    parseRujiraReservePaymentBlock
  } = await import('../src/shared/rujira-reserve-payments.js');

  const block = {
    result: {
      finalize_block_events: [
        event('transfer', {
          amount: '100rune',
          sender: 'thor1unrelated',
          recipient: TC_RESERVE_MODULE,
          mode: 'EndBlock'
        }),
        event('transfer', {
          amount: '609308000rune',
          sender: BASE_LAYER_REVENUE_COLLECTOR,
          recipient: TC_RESERVE_MODULE,
          mode: 'EndBlock'
        }),
        event('reserve', {
          amount: '609308000',
          coin: '609308000 THOR.RUNE',
          from: BASE_LAYER_REVENUE_COLLECTOR,
          to: TC_RESERVE_MODULE,
          memo: 'RESERVE',
          id: 'ABC123',
          mode: 'EndBlock'
        }),
        event('transfer', {
          amount: '89rune',
          sender: TC_RESERVE_MODULE,
          recipient: 'thor1node',
          mode: 'EndBlock'
        })
      ]
    }
  };

  const parsed = parseRujiraReservePaymentBlock(25982820, block, {
    blockTime: '2026-04-30T18:32:34.605Z',
    source: 'test'
  });

  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].height, 25982820);
  assert.equal(parsed.events[0].tx_id, 'ABC123');
  assert.equal(parsed.events[0].amount_base, '609308000');
  assert.equal(parsed.events[0].amount_rune, 6.09308);
  assert.equal(parsed.events[0].sender, BASE_LAYER_REVENUE_COLLECTOR);
  assert.equal(parsed.events[0].recipient, TC_RESERVE_MODULE);
  assert.equal(parsed.scan.transfer_event_count, 1);
  assert.equal(parsed.scan.reserve_event_count, 1);
  assert.equal(parsed.scan.matched_transfer_event_count, 1);
  assert.equal(parsed.scan.unmatched_transfer_event_count, 0);
});

test('parseRujiraReservePaymentBlock records the post-cutover Reserve and POL split', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    BASE_LAYER_REVENUE_COLLECTOR,
    TC_RESERVE_MODULE,
    THORCHAIN_POL_FUND,
    parseRujiraReservePaymentBlock
  } = await import('../src/shared/rujira-reserve-payments.js');

  const thorchainPolFund = 'thor1glpf75rxtuu0mahvf0cqg27ek22x9w0uc5rkpcf9g0d9499pqcdql3fgen';
  assert.equal(THORCHAIN_POL_FUND, thorchainPolFund);
  const parsed = parseRujiraReservePaymentBlock(27410412, {
    result: {
      finalize_block_events: [
        event('transfer', {
          amount: '390154666rune',
          sender: BASE_LAYER_REVENUE_COLLECTOR,
          recipient: TC_RESERVE_MODULE,
          mode: 'EndBlock'
        }),
        event('reserve', {
          amount: '390154666',
          coin: '390154666 THOR.RUNE',
          from: BASE_LAYER_REVENUE_COLLECTOR,
          to: TC_RESERVE_MODULE,
          memo: 'RESERVE',
          id: 'POSTCUTOVER',
          mode: 'EndBlock'
        }),
        event('transfer', {
          amount: '195077334rune',
          sender: BASE_LAYER_REVENUE_COLLECTOR,
          recipient: thorchainPolFund,
          mode: 'EndBlock'
        })
      ]
    }
  }, {
    blockTime: '2026-08-13T12:27:11.22025798Z',
    source: 'test'
  });

  assert.deepEqual(parsed.events.map((row) => ({
    paymentType: row.payment_type,
    recipient: row.recipient,
    amountBase: row.amount_base
  })), [
    {
      paymentType: 'reserve',
      recipient: TC_RESERVE_MODULE,
      amountBase: '390154666'
    },
    {
      paymentType: 'pol',
      recipient: thorchainPolFund,
      amountBase: '195077334'
    }
  ]);
  assert.equal(parsed.scan.pol_transfer_event_count, 1);
});

test('parseRujiraReservePaymentBlock records catch-up settlements emitted by a transaction', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    BASE_LAYER_REVENUE_COLLECTOR,
    TC_RESERVE_MODULE,
    THORCHAIN_POL_FUND,
    parseRujiraReservePaymentBlock
  } = await import('../src/shared/rujira-reserve-payments.js');

  const parsed = parseRujiraReservePaymentBlock(27545366, {
    result: {
      txs_results: [{
        events: [
          event('transfer', {
            amount: '220940513333rune',
            sender: BASE_LAYER_REVENUE_COLLECTOR,
            recipient: TC_RESERVE_MODULE,
            msg_index: '5'
          }),
          event('reserve', {
            amount: '220940513333',
            coin: '220940513333 THOR.RUNE',
            from: BASE_LAYER_REVENUE_COLLECTOR,
            contributor_address: BASE_LAYER_REVENUE_COLLECTOR,
            to: TC_RESERVE_MODULE,
            memo: 'RESERVE',
            id: '3E261FBBDFC92578FDD0C32A3A9DE3E8B9DC6A472E02750C5869B8170AB45CA7',
            msg_index: '5'
          }),
          event('transfer', {
            amount: '110470256667rune',
            sender: BASE_LAYER_REVENUE_COLLECTOR,
            recipient: THORCHAIN_POL_FUND,
            msg_index: '5'
          })
        ]
      }],
      finalize_block_events: []
    }
  }, {
    blockTime: '2026-08-23T10:33:08.290494566Z',
    source: 'test'
  });

  assert.deepEqual(parsed.events.map((row) => ({
    paymentType: row.payment_type,
    recipient: row.recipient,
    amountBase: row.amount_base
  })), [
    {
      paymentType: 'reserve',
      recipient: TC_RESERVE_MODULE,
      amountBase: '220940513333'
    },
    {
      paymentType: 'pol',
      recipient: THORCHAIN_POL_FUND,
      amountBase: '110470256667'
    }
  ]);
});

test('parseRujiraReservePaymentBlock reads transaction settlements from a live NewBlock payload', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    BASE_LAYER_REVENUE_COLLECTOR,
    TC_RESERVE_MODULE,
    parseRujiraReservePaymentBlock
  } = await import('../src/shared/rujira-reserve-payments.js');

  const parsed = parseRujiraReservePaymentBlock(27545366, {
    block: {
      header: {
        height: '27545366',
        time: '2026-08-23T10:33:08.290494566Z'
      }
    },
    result_finalize_block: {
      tx_results: [{
        events: [
          event('transfer', {
            amount: '220940513333rune',
            sender: BASE_LAYER_REVENUE_COLLECTOR,
            recipient: TC_RESERVE_MODULE
          }),
          event('reserve', {
            amount: '220940513333',
            coin: '220940513333 THOR.RUNE',
            from: BASE_LAYER_REVENUE_COLLECTOR,
            to: TC_RESERVE_MODULE,
            memo: 'RESERVE',
            id: 'CATCHUP'
          })
        ]
      }],
      events: []
    }
  }, { source: 'test' });

  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].amount_rune, 2209.40513333);
  assert.equal(parsed.events[0].block_time, '2026-08-23T10:33:08.290Z');
});

test('parseRujiraReservePaymentBlock does not pair Reserve evidence across transactions', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    BASE_LAYER_REVENUE_COLLECTOR,
    TC_RESERVE_MODULE,
    parseRujiraReservePaymentBlock
  } = await import('../src/shared/rujira-reserve-payments.js');

  const parsed = parseRujiraReservePaymentBlock(27545366, {
    result: {
      txs_results: [
        {
          events: [event('transfer', {
            amount: '100000000rune',
            sender: BASE_LAYER_REVENUE_COLLECTOR,
            recipient: TC_RESERVE_MODULE
          })]
        },
        {
          events: [event('reserve', {
            amount: '100000000',
            coin: '100000000 THOR.RUNE',
            from: BASE_LAYER_REVENUE_COLLECTOR,
            to: TC_RESERVE_MODULE,
            memo: 'RESERVE',
            id: 'SECOND_TX'
          })]
        }
      ]
    }
  }, {
    blockTime: '2026-08-23T10:33:08.290494566Z',
    source: 'test'
  });

  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].tx_id, 'SECOND_TX');
  assert.equal(parsed.events[0].raw_event.transfer, null);
  assert.equal(parsed.scan.matched_transfer_event_count, 0);
  assert.equal(parsed.scan.unmatched_transfer_event_count, 1);
  assert.equal(parsed.scan.reserve_only_event_count, 1);
});

test('parseRujiraReservePaymentBlock ignores settlement events from failed transactions', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    BASE_LAYER_REVENUE_COLLECTOR,
    TC_RESERVE_MODULE,
    parseRujiraReservePaymentBlock
  } = await import('../src/shared/rujira-reserve-payments.js');

  const parsed = parseRujiraReservePaymentBlock(27545366, {
    result: {
      txs_results: [{
        code: 5,
        events: [
          event('transfer', {
            amount: '100000000rune',
            sender: BASE_LAYER_REVENUE_COLLECTOR,
            recipient: TC_RESERVE_MODULE
          }),
          event('reserve', {
            amount: '100000000',
            coin: '100000000 THOR.RUNE',
            from: BASE_LAYER_REVENUE_COLLECTOR,
            to: TC_RESERVE_MODULE,
            memo: 'RESERVE',
            id: 'ROLLED_BACK'
          })
        ]
      }]
    }
  }, {
    blockTime: '2026-08-23T10:33:08.290494566Z',
    source: 'test'
  });

  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.scan.matched_event_count, 0);
});

test('parseRujiraReservePaymentBlock does not classify POL transfers before the cutover', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    BASE_LAYER_REVENUE_COLLECTOR,
    parseRujiraReservePaymentBlock
  } = await import('../src/shared/rujira-reserve-payments.js');

  const parsed = parseRujiraReservePaymentBlock(27410411, {
    result: {
      finalize_block_events: [
        event('transfer', {
          amount: '195077334rune',
          sender: BASE_LAYER_REVENUE_COLLECTOR,
          recipient: 'thor1glpf75rxtuu0mahvf0cqg27ek22x9w0uc5rkpcf9g0d9499pqcdql3fgen',
          mode: 'EndBlock'
        })
      ]
    }
  }, {
    blockTime: '2026-08-13T12:26:59Z',
    source: 'test'
  });

  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.scan.pol_transfer_event_count, 0);
});

test('migration 045 repairs the POL constraint and rewinds settlement scanning', async () => {
  const migration = await readFile(
    new URL('../migrations/045_correct_rujira_pol_fund.sql', import.meta.url),
    'utf8'
  );

  assert.match(migration, /drop constraint if exists rujira_reserve_payment_events_payment_type_check/i);
  assert.match(migration, /delete from public\.event_source_observations/i);
  assert.match(migration, /delete from public\.rujira_reserve_payment_events/i);
  assert.match(
    migration,
    /payment_type = 'pol'[\s\S]*recipient = 'thor1glpf75rxtuu0mahvf0cqg27ek22x9w0uc5rkpcf9g0d9499pqcdql3fgen'/i
  );
  assert.match(migration, /where height >= 27410412/i);
  assert.match(migration, /least\(rujira_reserve_payment_sync_state\.next_scheduled_height, excluded\.next_scheduled_height\)/i);
});

test('migration 048 requeues the known post-halt catch-up settlement block', async () => {
  const migration = await readFile(
    new URL('../migrations/048_rujira_catchup_settlements.sql', import.meta.url),
    'utf8'
  );

  assert.match(migration, /27545366/);
  assert.match(migration, /insert into public\.rujira_reserve_payment_blocks/i);
  assert.match(migration, /on conflict \(height\)/i);
  assert.match(migration, /status = 'pending'/i);
  assert.match(migration, /next_retry_at = now\(\)/i);
});

test('parseRujiraReservePaymentBlock falls back to reserve event when transfer is absent', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    BASE_LAYER_REVENUE_COLLECTOR,
    TC_RESERVE_MODULE,
    parseRujiraReservePaymentBlock
  } = await import('../src/shared/rujira-reserve-payments.js');

  const parsed = parseRujiraReservePaymentBlock(25982921, {
    result: {
      finalize_block_events: [
        event('reserve', {
          amount: '592640000',
          coin: '592640000 THOR.RUNE',
          contributor_address: BASE_LAYER_REVENUE_COLLECTOR,
          to: TC_RESERVE_MODULE,
          memo: 'RESERVE',
          id: 'DEF456'
        })
      ]
    }
  }, {
    blockTime: '2026-04-30T18:43:14.000Z',
    source: 'test'
  });

  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].tx_id, 'DEF456');
  assert.equal(parsed.events[0].amount_rune, 5.9264);
  assert.equal(parsed.scan.transfer_event_count, 0);
  assert.equal(parsed.scan.reserve_event_count, 1);
  assert.equal(parsed.scan.reserve_only_event_count, 1);
});

test('parseRujiraReservePaymentBlock does not label an unmatched transfer as RESERVE', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    BASE_LAYER_REVENUE_COLLECTOR,
    TC_RESERVE_MODULE,
    parseRujiraReservePaymentBlock
  } = await import('../src/shared/rujira-reserve-payments.js');

  const parsed = parseRujiraReservePaymentBlock(25983022, {
    result: {
      finalize_block_events: [
        event('transfer', {
          amount: '659312000rune',
          sender: BASE_LAYER_REVENUE_COLLECTOR,
          recipient: TC_RESERVE_MODULE,
          mode: 'EndBlock'
        })
      ]
    }
  }, {
    blockTime: '2026-04-30T18:55:06.472Z',
    source: 'test'
  });

  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.scan.transfer_event_count, 1);
  assert.equal(parsed.scan.reserve_event_count, 0);
  assert.equal(parsed.scan.unmatched_transfer_event_count, 1);
});

test('buildRujiraReservePaymentRowsFromDune requires the explicit Reserve path and RUNE coin', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    BASE_LAYER_REVENUE_COLLECTOR,
    TC_RESERVE_MODULE,
    buildRujiraReservePaymentRowsFromDune
  } = await import('../src/shared/rujira-reserve-payments.js');

  const valid = {
    event_key: 'dune-valid-reserve-payment',
    height: 25982820,
    block_time: '2026-04-30T18:32:34.605Z',
    tx_id: 'DUNE123',
    sender: BASE_LAYER_REVENUE_COLLECTOR,
    recipient: TC_RESERVE_MODULE,
    memo: 'RESERVE',
    amount_base: '609308000',
    amount_rune: 999,
    rune_price_usd: 0.5,
    amount_usd: 3.04654,
    coin: '609308000 THOR.RUNE'
  };

  const rows = buildRujiraReservePaymentRowsFromDune([
    valid,
    { ...valid, event_key: 'missing-sender', sender: '' },
    { ...valid, event_key: 'missing-recipient', recipient: '' },
    { ...valid, event_key: 'missing-memo', memo: '' },
    { ...valid, event_key: 'missing-coin', coin: '' },
    { ...valid, event_key: 'wrong-recipient', recipient: 'thor1unrelated' },
    { ...valid, event_key: 'wrong-memo', memo: 'ADD:THOR.RUNE' },
    { ...valid, event_key: 'non-rune-coin', coin: '609308000 BTC.BTC' },
    { ...valid, event_key: 'mismatched-amount', amount_base: '609308001' }
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].sender, BASE_LAYER_REVENUE_COLLECTOR);
  assert.equal(rows[0].recipient, TC_RESERVE_MODULE);
  assert.equal(rows[0].memo, 'RESERVE');
  assert.equal(rows[0].coin, '609308000 THOR.RUNE');
  assert.equal(rows[0].amount_base, '609308000');
  assert.equal(rows[0].amount_rune, 6.09308);
});

test('parseRujiraReservePaymentSchedule finds the collector in a shared scheduler entry', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const {
    BASE_LAYER_REVENUE_COLLECTOR,
    parseRujiraReservePaymentSchedule
  } = await import('../src/shared/rujira-reserve-payments.js');

  const schedule = parseRujiraReservePaymentSchedule({
    schedules: [{
      height: '27184778',
      msgs: [
        {
          sender: 'thor1unrelated',
          after: '100',
          msg: Buffer.from(JSON.stringify({ run: {} })).toString('base64')
        },
        {
          sender: BASE_LAYER_REVENUE_COLLECTOR,
          after: '100',
          msg: Buffer.from(JSON.stringify({ run: {} })).toString('base64')
        }
      ]
    }]
  });

  assert.deepEqual(schedule, {
    height: 27184778,
    after: 100,
    cadence: 101
  });
});

test('buildRujiraReservePaymentScheduleCandidates keeps a rolling recovery window', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { buildRujiraReservePaymentScheduleCandidates } = await import('../src/shared/rujira-reserve-payments.js');

  const heights = buildRujiraReservePaymentScheduleCandidates({
    anchorHeight: 1101,
    stopHeight: 1000,
    cadence: 101,
    minHeight: 1,
    limit: 4
  });

  assert.deepEqual(heights, [697, 798, 899, 1000]);
});

test('schedule range candidates resume an outage from the oldest unscanned height', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { buildRujiraReservePaymentScheduleRangeCandidates } = await import('../src/shared/rujira-reserve-payments.js');

  const heights = buildRujiraReservePaymentScheduleRangeCandidates({
    anchorHeight: 1101,
    startHeight: 1000,
    stopHeight: 100000,
    cadence: 101,
    limit: 4
  });

  assert.deepEqual(heights, [1000, 1101, 1202, 1303]);
});

test('live scheduler phase recovers the July 26 heights missed by the fixed phase scanner', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { buildRujiraReservePaymentScheduleCandidates } = await import('../src/shared/rujira-reserve-payments.js');

  const heights = buildRujiraReservePaymentScheduleCandidates({
    anchorHeight: 27184778,
    stopHeight: 27183780,
    cadence: 101,
    minHeight: 25982820,
    limit: 300
  });

  assert.equal(heights.includes(27160134), true);
  assert.equal(heights.includes(27173769), true);
  assert.equal(heights.includes(27160076), false);
  assert.equal((27160134 - 25982820) % 101, 58);
});

test('payment block processing keeps the known catch-up repair pending until both destinations exist', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { processRujiraReservePaymentBlocks } = await import('../src/shared/rujira-reserve-payments.js');
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/select height, block_time, source, attempts/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    }
  };

  const result = await processRujiraReservePaymentBlocks(client, { limit: 1 });

  assert.equal(result.selected, 0);
  assert.match(queries[0].sql, /insert into rujira_reserve_payment_blocks/i);
  assert.match(queries[0].sql, /status = 'pending'/i);
  assert.deepEqual(queries[0].params.slice(0, 4), [
    27545366,
    '2026-08-23T10:33:08.290494566Z',
    '220940513333',
    '110470256667'
  ]);
});

test('Dune-era settlement ingestion also discovers recent Midgard contract executions', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { runRujiraReservePaymentsScheduledSettlementIngestion } = await import(
    '../src/shared/rujira-reserve-payments.js'
  );
  const calls = [];

  const result = await runRujiraReservePaymentsScheduledSettlementIngestion({}, {}, {
    ingestMidgardCandidates: async (_client, options) => {
      calls.push('midgard');
      assert.equal(options.maxPages, 1);
      return { heights: 1 };
    },
    ingestScheduledCandidates: async () => {
      calls.push('scheduled');
      return { selected: 1 };
    },
    processBlocks: async () => {
      calls.push('blocks');
      return { events: 2 };
    },
    refreshPrices: async () => {
      calls.push('prices');
      return { priced_events: 2 };
    }
  });

  assert.deepEqual(calls, ['midgard', 'scheduled', 'blocks', 'prices']);
  assert.equal(result.midgard_candidates.heights, 1);
  assert.equal(result.block_scan.events, 2);
});

test('Dune-era scheduled settlement scanning survives an ordinary Midgard candidate error', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { runRujiraReservePaymentsScheduledSettlementIngestion } = await import(
    '../src/shared/rujira-reserve-payments.js'
  );
  const calls = [];

  const result = await runRujiraReservePaymentsScheduledSettlementIngestion({}, {}, {
    ingestMidgardCandidates: async () => {
      calls.push('midgard');
      throw new Error('temporary Midgard failure');
    },
    ingestScheduledCandidates: async () => {
      calls.push('scheduled');
      return { selected: 1 };
    },
    processBlocks: async () => {
      calls.push('blocks');
      return { events: 2 };
    },
    refreshPrices: async () => {
      calls.push('prices');
      return { priced_events: 2 };
    }
  });

  assert.deepEqual(calls, ['midgard', 'scheduled', 'blocks', 'prices']);
  assert.equal(result.midgard_candidates.error, 'temporary Midgard failure');
  assert.equal(result.block_scan.events, 2);
});

test('legacy fallback survives a cooled-down Midgard candidate lane and continues RPC settlement work', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { runRujiraReservePaymentsLegacyIngestion } = await import(
    '../src/shared/rujira-reserve-payments.js'
  );
  const calls = [];

  const result = await runRujiraReservePaymentsLegacyIngestion({}, {}, {
    ingestMidgardCandidates: async () => {
      calls.push('midgard');
      throw new Error('Provider THORChain Midgard is cooling down after a 500 response');
    },
    ingestScheduledCandidates: async () => {
      calls.push('scheduled');
      return { selected: 1 };
    },
    processBlocks: async () => {
      calls.push('blocks');
      return { events: 2 };
    },
    refreshPrices: async () => {
      calls.push('prices');
      return { priced_events: 2 };
    }
  });

  assert.deepEqual(calls, ['midgard', 'scheduled', 'blocks', 'prices']);
  assert.match(result.midgard_candidates.error, /cooling down after a 500 response/);
  assert.equal(result.block_scan.events, 2);
});

test('legacy fallback preserves completed settlement work when Midgard pricing is cooled down', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { runRujiraReservePaymentsLegacyIngestion } = await import(
    '../src/shared/rujira-reserve-payments.js'
  );

  const result = await runRujiraReservePaymentsLegacyIngestion({}, {}, {
    ingestMidgardCandidates: async () => ({ heights: 1 }),
    ingestScheduledCandidates: async () => ({ selected: 1 }),
    processBlocks: async () => ({ events: 2 }),
    refreshPrices: async () => {
      throw new Error('Provider THORChain Midgard is cooling down during price refresh');
    }
  });

  assert.equal(result.block_scan.events, 2);
  assert.match(result.pricing.error, /cooling down during price refresh/);
});

test('successful Dune Reserve ingestion still runs the scheduled settlement scanner', async () => {
  process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
  const { runRujiraReservePaymentsIngestion } = await import('../src/shared/rujira-reserve-payments.js');
  const calls = [];
  const duneSource = { source: 'dune', upserted: 12 };

  const result = await runRujiraReservePaymentsIngestion({}, {
    runDune: async () => {
      calls.push('dune');
      return duneSource;
    },
    runScheduledSettlements: async (_client, initialStats) => {
      calls.push('scheduled-settlements');
      assert.equal(initialStats.dune_source, duneSource);
      return { ...initialStats, block_scan: { events: 2 } };
    },
    runLegacy: async () => {
      calls.push('legacy');
      return {};
    }
  });

  assert.deepEqual(calls, ['dune', 'scheduled-settlements']);
  assert.equal(result.dune_source, duneSource);
  assert.equal(result.block_scan.events, 2);
});
