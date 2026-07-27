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
