import assert from 'node:assert/strict';
import test from 'node:test';
import { BinaryWriter } from 'cosmjs-types/binary.js';
import { QueryBalanceResponse } from 'cosmjs-types/cosmos/bank/v1beta1/query.js';
import {
  FINANCIAL_RESERVE_ADDRESS, calculateFinancialReserveEmissionE8,
  fetchFinancialReserveAnchor, parseFinancialReserveObservation, replayFinancialReserveEmissions
} from '../src/shared/financials-reserve-emissions.js';

const height = 28204118;
const event = (type, attributes) => ({ type, attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: String(value) })) });
const received = (amount) => event('coin_received', { receiver: FINANCIAL_RESERVE_ADDRESS, amount: `${amount}rune` });
const spent = (amount) => event('coin_spent', { spender: FINANCIAL_RESERVE_ADDRESS, amount: `${amount}rune` });
const allocations = { bond_reward: '146041506', dev_fund_reward: '14116495', income_burn: '2823299',
  tcy_stake_reward: '28232991', marketing_fund_reward: '14116495', pol_reserve_reward: '56465981',
  'BSC.USDT-0X55D398326F99059FF775485246999027B3197955': '557731', 'ETH.ETH': '10200461',
  'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T': '9774948' };

// Compact amounts verified from Liquify block 28204118 and height-verified
// historical Bank Balance/Version/MimirValues ABCI on 2026-10-13.
function blockPayload() {
  return { result: { height: String(height), txs_results: [{ code: 0, events: [received('10000000')] }],
    finalize_block_events: [received('282472710'), spent('147625'), event('rev_share', { payout: '147625' }),
      ...Object.values(allocations).map(spent), event('rewards', { ...allocations, mode: 'EndBlock' }),
      spent('2064617340'), received('2064617340')] } };
}
const anchor = { height, reserveBalanceE8: '2534440071363139', version: '3.20.3',
  emissionCurve: '100000', reserveMaxCapE8: '0', blocksPerYear: '5256000' };

test('compact Reserve observation includes transaction and finalized bank movements once', () => {
  const point = parseFinancialReserveObservation(blockPayload(), height);
  assert.deepEqual(point, { schemaVersion: 1, height, reserveDeltaE8: '9995178', afterRewardsDeltaE8: '0',
    rewardTransfersE8: '282329907', rewardEventCount: 1, configChanges: [] });
  const payload = blockPayload();
  payload.result.finalize_block_events.push(spent('7'));
  assert.equal(parseFinancialReserveObservation(payload, height).afterRewardsDeltaE8, '-7');
});

test('capturing EndBlock alone is incomplete, never a full-block balance replay', () => {
  const payload = blockPayload();
  delete payload.result.txs_results;
  assert.equal(parseFinancialReserveObservation(payload, height), null);
  assert.equal(parseFinancialReserveObservation({ result: { height, end_block_events: [] } }, height), null);
});

test('parser handles NewBlock envelopes and base64 attributes without double counting tx results', () => {
  const payload = blockPayload().result;
  const base64Event = (entry) => ({ ...entry, attributes: entry.attributes.map(({ key, value }) => ({
    key: Buffer.from(key).toString('base64'), value: Buffer.from(value).toString('base64') })) });
  const envelope = { block: { header: { height: String(height) } }, result_finalize_block: {
    events: payload.finalize_block_events.map(base64Event), tx_results: payload.txs_results.map(row => ({ ...row, events: row.events.map(base64Event) })) } };
  assert.deepEqual(parseFinancialReserveObservation(envelope, height), parseFinancialReserveObservation({ result: payload }, height));
});

test('malformed reserve amounts, negative rewards, duplicate attributes and wrong heights fail closed', () => {
  assert.throws(() => parseFinancialReserveObservation(blockPayload(), height + 1), /height/);
  for (const bad of [event('coin_spent', { spender: FINANCIAL_RESERVE_ADDRESS, amount: 'bad' }),
    event('rewards', { bond_reward: '-1' }), event('rewards', { mystery_reward: '1' })]) {
    const payload = blockPayload(); payload.result.finalize_block_events.push(bad);
    assert.throws(() => parseFinancialReserveObservation(payload, height));
  }
  const payload = blockPayload(); payload.result.finalize_block_events[0].attributes.push({ key: 'amount', value: '1rune' });
  assert.throws(() => parseFinancialReserveObservation(payload, height), /Duplicate/);
});

test('exact replay matches known emission and independently verified previous closing Reserve', () => {
  const result = replayFinancialReserveEmissions([parseFinancialReserveObservation(blockPayload(), height)], anchor);
  assert.deepEqual(result, { blocks: [{ height, reserveEmissionsE8: '4822', reserveBeforeRewardsE8: '2534440353693046' }],
    previousHeight: height - 1, previousReserveBalanceE8: '2534440061367961', method: 'historical-reserve-formula-v1' });
});

test('replay uses reward-event position, not closing Reserve when later transfers exist', () => {
  const payload = blockPayload(); payload.result.finalize_block_events.push(spent('1000000000000'));
  const result = replayFinancialReserveEmissions([parseFinancialReserveObservation(payload, height)], {
    ...anchor, reserveBalanceE8: (BigInt(anchor.reserveBalanceE8) - 1000000000000n).toString()
  });
  assert.equal(result.blocks[0].reserveEmissionsE8, '4822');
  assert.equal(result.previousReserveBalanceE8, '2534440061367961');
});

test('formula reproduces SDK half-to-even rounding, Reserve cap override, and exact large balances', () => {
  const params = { ...anchor, blocksPerYear: '5256000', emissionCurve: '2' };
  assert.equal(calculateFinancialReserveEmissionE8('5256000', params), '0');
  assert.equal(calculateFinancialReserveEmissionE8('15768000', params), '2');
  assert.equal(calculateFinancialReserveEmissionE8('26280000', params), '2');
  assert.equal(calculateFinancialReserveEmissionE8('31536001', { ...params, reserveMaxCapE8: '31536000' }), '1');
  assert.equal(calculateFinancialReserveEmissionE8('9007199254740993', anchor), '17137');
});

test('replay rejects gaps, unsupported versions/configurations, missing rewards and invalid balance anchors', () => {
  const point = parseFinancialReserveObservation(blockPayload(), height);
  for (const bad of [{ ...anchor, height: height + 1 }, { ...anchor, version: '3.21.0' },
    { ...anchor, reserveBalanceE8: '-1' }, { ...anchor, emissionCurve: '0' }, { ...anchor, blocksPerYear: '1' }]) {
    assert.throws(() => replayFinancialReserveEmissions([point], bad));
  }
  assert.throws(() => replayFinancialReserveEmissions([point, { ...point, height: height - 2 }], anchor), /contiguous/);
  assert.throws(() => replayFinancialReserveEmissions([{ ...point, rewardEventCount: 0 }], anchor), /rewards/);
  assert.throws(() => replayFinancialReserveEmissions([{ ...point, reserveDeltaE8: '9999999999999999999' }], anchor), /balance/);
});

test('relevant Mimir and version changes require another explicit anchor rather than guessing historical configuration', () => {
  for (const change of [event('set_mimir', { key: 'EmissionCurve', value: '200000' }), event('version', { version: '3.20.3' })]) {
    const payload = blockPayload(); payload.result.finalize_block_events.push(change);
    const observation = parseFinancialReserveObservation(payload, height);
    assert.equal(observation.configChanges.length, 1);
    assert.throws(() => replayFinancialReserveEmissions([observation], anchor), /configuration/);
  }
});

function abciResponse(value, atHeight = height) {
  return { result: { response: { code: 0, height: String(atHeight), value: Buffer.from(value).toString('base64') } } };
}
function mimirBytes(entries) {
  const writer = BinaryWriter.create();
  for (const [key, value] of entries) {
    const item = BinaryWriter.create().uint32(10).string(key);
    if (value !== '0') item.uint32(16).int64(BigInt(value));
    writer.uint32(10).bytes(item.finish());
  }
  return writer.finish();
}
function anchorGetJson(overrides = {}) {
  return async (url) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get('height'), String(height));
    const route = JSON.parse(params.get('path'));
    if (overrides[route]) return overrides[route];
    if (route.endsWith('/Balance')) return abciResponse(QueryBalanceResponse.encode({ balance: { denom: 'rune', amount: anchor.reserveBalanceE8 } }).finish());
    if (route.endsWith('/Version')) return abciResponse(BinaryWriter.create().uint32(10).string('3.20.3').finish());
    if (route.endsWith('/MimirValues')) return abciResponse(mimirBytes([['EMISSIONCURVE', '100000'], ['SYNTHYIELDBASISPOINTS', '0']]));
    throw new Error('Unexpected request');
  };
}

test('anchor acquisition verifies historical bank, protocol version and Mimir heights', async () => {
  const result = await fetchFinancialReserveAnchor(height, { getJson: anchorGetJson() });
  assert.deepEqual(result, { ...anchor, method: 'historical-reserve-formula-v1',
    source: 'liquify-rpc:height-verified-bank-version-mimirs' });
  await assert.rejects(fetchFinancialReserveAnchor(height, { getJson: anchorGetJson({
    '/cosmos.bank.v1beta1.Query/Balance': abciResponse(QueryBalanceResponse.encode({ balance: { denom: 'rune', amount: '1' } }).finish(), height + 1)
  }) }), /height/);
});

test('anchor uses pinned constant defaults only for absent or disabled Mimir overrides', async () => {
  const result = await fetchFinancialReserveAnchor(height, { getJson: anchorGetJson({
    '/types.Query/MimirValues': abciResponse(mimirBytes([['EMISSIONCURVE', '-1'], ['RESERVEMAXCAP', '9']]))
  }) });
  assert.equal(result.emissionCurve, '6');
  assert.equal(result.reserveMaxCapE8, '9');
  await assert.rejects(fetchFinancialReserveAnchor(height, { getJson: anchorGetJson({
    '/types.Query/Version': abciResponse(BinaryWriter.create().uint32(10).string('3.20.4').finish())
  }) }), /Unsupported/);
});
