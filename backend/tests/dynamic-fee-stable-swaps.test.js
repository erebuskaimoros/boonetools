import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STABLE_SWAP_SYMBOLS,
  buildStableSwapDays,
  isStableSwapRoute,
  stableSwapSymbol
} from '../../shared/dynamic-fees/stable-swaps.js';
import { isStablecoin } from '../../shared/blockchain.js';
import { stableSwapCoverageStart, stableSwapDayRange, buildStableSwapMimirChanges } from '../src/shared/dynamic-fee-stable-swaps.js';
import { buildDynamicFeeStableSwapsParams } from '../src/handlers/dynamic-fee-stable-swaps.js';

const USDC = 'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48';
const USDT = 'ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7';

test('stableSwapSymbol classifies layer-1, trade and secured stablecoins case-insensitively', () => {
  assert.equal(stableSwapSymbol(USDC), 'USDC');
  assert.equal(stableSwapSymbol('ETH~USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7'), 'USDT');
  assert.equal(stableSwapSymbol('ETH-USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48'), 'USDC');
  assert.equal(stableSwapSymbol('bsc.usdt-0x55d398326f99059ff775485246999027b3197955'), 'USDT');
  assert.equal(stableSwapSymbol('AVAX~usdc-0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'), 'USDC');
  assert.equal(stableSwapSymbol('ETH.DAI-0X6B175474E89094C44DA98B954EEDEAC495271D0F'), 'DAI');
  assert.equal(stableSwapSymbol('ETH.GUSD'), 'GUSD');
  for (const symbol of STABLE_SWAP_SYMBOLS) {
    assert.equal(isStablecoin(`ETH.${symbol}-0X1234567890AB`), true, `${symbol} matches isStablecoin`);
  }
});

test('stableSwapSymbol rejects non-stable assets and lookalikes', () => {
  for (const asset of ['ETH.ETH', 'THOR.RUNE', 'BTC.BTC', 'ETH.USDCX-0X1234567890AB', 'ETH~XUSDC-0X12',
    'USDC', 'ETH', 'ETH.', '', null, undefined, 'ETH/USDC-0X12', 'ETH.USDC.X']) {
    assert.equal(stableSwapSymbol(asset), '', String(asset));
  }
});

test('isStableSwapRoute requires both sides to be stablecoins', () => {
  assert.equal(isStableSwapRoute(USDC, 'ETH~USDT-0XDAC1'), true);
  assert.equal(isStableSwapRoute(USDC, 'BTC.BTC'), false);
  assert.equal(isStableSwapRoute('THOR.RUNE', USDT), false);
  assert.equal(isStableSwapRoute(USDC, ''), false);
});

test('buildStableSwapDays zero-fills a contiguous range and sums routes per day', () => {
  const days = buildStableSwapDays([
    { day: '2026-11-02', input_asset: USDC, output_asset: USDT, swaps: '2', input_e8: '150000000000', fee_rune_e8: '100000000', fee_usd_e8: '150000000', unpriced_swaps: '0' },
    { day: '2026-11-02', input_asset: 'ETH-USDT-0XDAC1', output_asset: 'ETH~USDC-0XA0B8', swaps: '1', input_e8: '50000000000', fee_rune_e8: '20000000', fee_usd_e8: '30000000', unpriced_swaps: '0' },
    { day: '2026-11-02', input_asset: USDC, output_asset: 'BTC.BTC', swaps: '9', input_e8: '900000000000000', fee_rune_e8: '900000000', fee_usd_e8: '900000000', unpriced_swaps: '0' }
  ], { fromDay: '2026-11-01', toDay: '2026-11-03', currentDay: '2026-11-03' });

  assert.deepEqual(days, [
    { day: '2026-11-01', swaps: 0, volume_usd: 0, fees_rune: 0, fees_usd: 0, partial: false },
    { day: '2026-11-02', swaps: 3, volume_usd: 2000, fees_rune: 1.2, fees_usd: 1.8, partial: false },
    { day: '2026-11-03', swaps: 0, volume_usd: 0, fees_rune: 0, fees_usd: 0, partial: true }
  ]);
  assert.deepEqual(buildStableSwapDays([], { fromDay: '2026-11-04', toDay: '2026-11-03' }), []);
});

test('buildStableSwapDays reports null fee USD only when no swap on the day could be priced', () => {
  const [unpriced, mixed, zeroFee] = buildStableSwapDays([
    { day: '2026-11-01', input_asset: USDC, output_asset: USDT, swaps: '2', input_e8: '100', fee_rune_e8: '500000000', fee_usd_e8: null, unpriced_swaps: '2' },
    { day: '2026-11-02', input_asset: USDC, output_asset: USDT, swaps: '1', input_e8: '100', fee_rune_e8: '500000000', fee_usd_e8: null, unpriced_swaps: '1' },
    { day: '2026-11-02', input_asset: USDT, output_asset: USDC, swaps: '1', input_e8: '100', fee_rune_e8: '100000000', fee_usd_e8: '200000000', unpriced_swaps: '0' },
    { day: '2026-11-03', input_asset: USDT, output_asset: USDC, swaps: '1', input_e8: '100', fee_rune_e8: '0', fee_usd_e8: '0', unpriced_swaps: '0' }
  ], { fromDay: '2026-11-01', toDay: '2026-11-03' });

  assert.equal(unpriced.fees_usd, null);
  assert.equal(unpriced.fees_rune, 5);
  assert.equal(mixed.fees_usd, 2, 'a partly priced day sums the priced swaps');
  assert.equal(zeroFee.fees_usd, 0);
});

test('buildDynamicFeeStableSwapsParams bounds days and ignores invalid input', () => {
  const nowMs = Date.parse('2026-11-13T15:00:00Z');
  const params = query => buildDynamicFeeStableSwapsParams(new URL(`https://boone.tools/x${query}`), nowMs);
  assert.deepEqual(params(''), { days: 400, nowMs, currentDay: '2026-11-13' });
  assert.equal(params('?days=30').days, 30);
  assert.equal(params('?days=0').days, 1);
  assert.equal(params('?days=-5').days, 1);
  assert.equal(params('?days=9999').days, 400);
  assert.equal(params('?days=abc').days, 400);
  assert.equal(params('?days=7.9').days, 7);
});

test('stable swap coverage begins on the first fully recorded UTC day', () => {
  assert.equal(stableSwapCoverageStart('2026-10-05T00:00:00Z'), '2026-10-05');
  assert.equal(stableSwapCoverageStart(new Date('2026-10-05T00:00:00.001Z')), '2026-10-06');
  assert.equal(stableSwapCoverageStart('2026-10-05T13:45:00Z'), '2026-10-06');
  assert.equal(stableSwapCoverageStart(null), null);

  const nowMs = Date.parse('2026-11-13T15:00:00Z');
  assert.deepEqual(stableSwapDayRange({ coverageStart: '2026-10-06', days: 400, nowMs }), { fromDay: '2026-10-06', toDay: '2026-11-13' });
  assert.deepEqual(stableSwapDayRange({ coverageStart: '2026-10-06', days: 7, nowMs }), { fromDay: '2026-11-07', toDay: '2026-11-13' });
  assert.equal(stableSwapDayRange({ coverageStart: null, days: 7, nowMs }), null);
});

test('stable swap mimir changes keep dated value changes per key', () => {
  assert.deepEqual(buildStableSwapMimirChanges([
    { mimir_key: 'StableSlipMinBps', mimir_value: '2', height: '10', block_time: '2026-04-30T22:39:04Z' },
    { mimir_key: 'STABLESLIPMINBPS', mimir_value: '2', height: 11, block_time: '2026-05-01T00:00:00Z' },
    { mimir_key: 'STABLESLIPMINBPS-ETH.USDC', mimir_value: '5', height: 12, block_time: new Date('2026-06-01T12:00:00Z') },
    { mimir_key: 'STABLESLIPMINBPS', mimir_value: '10', height: 13, block_time: '2026-11-11T02:41:47Z' },
    { mimir_key: 'L1SLIPMINBPS', mimir_value: '5', height: 14, block_time: '2026-11-11T03:00:00Z' },
    { mimir_key: 'STABLESLIPMINBPS', mimir_value: '12', height: 15, block_time: null }
  ]), [
    { key: 'STABLESLIPMINBPS', value: '2', previous_value: null, time: '2026-04-30T22:39:04.000Z', day: '2026-04-30', height: 10 },
    { key: 'STABLESLIPMINBPS-ETH.USDC', value: '5', previous_value: null, time: '2026-06-01T12:00:00.000Z', day: '2026-06-01', height: 12 },
    { key: 'STABLESLIPMINBPS', value: '10', previous_value: '2', time: '2026-11-11T02:41:47.000Z', day: '2026-11-11', height: 13 }
  ]);
});
