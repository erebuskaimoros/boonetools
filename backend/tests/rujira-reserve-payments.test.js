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
});
