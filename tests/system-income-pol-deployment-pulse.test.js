import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseChainHeadEvent } from '../src/lib/api/chain-stream.js';
import { buildSystemIncomePolDeploymentPulse } from '../src/lib/system-income-pol/live.js';

const head = deployments => ({ height: 101, pol_reserve_deployments: deployments });

test('deposit pulse identifies the receiving pool without its long contract suffix', () => {
  const asset = 'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T';
  assert.deepEqual(buildSystemIncomePolDeploymentPulse(head([{ asset, rune_e8: '6000000' }])), {
    height: 101,
    runeE8: '6000000',
    asset,
    label: 'TRON.USDT'
  });
});

test('pulse preserves the single deployment amount exactly without mutating the event', () => {
  const event = head([{ asset: 'BSC.USDT-TOKEN', rune_e8: '9007199254740993' }]);
  const original = structuredClone(event);
  assert.deepEqual(buildSystemIncomePolDeploymentPulse(event), {
    height: 101,
    runeE8: '9007199254740993',
    asset: 'BSC.USDT-TOKEN',
    label: 'BSC.USDT'
  });
  assert.deepEqual(event, original);
});

test('pulse uses the normalized live-stream pool and amount aliases', () => {
  const event = parseChainHeadEvent({
    height: 101, time: '2026-10-23T12:00:00Z',
    pol_reserve_deployments: [{ pool: 'ZEC.ZEC', rune_amount_e8: '12345678' }]
  });
  assert.deepEqual(buildSystemIncomePolDeploymentPulse(event), {
    height: 101, asset: 'ZEC.ZEC', label: 'ZEC.ZEC', runeE8: '12345678'
  });
});

test('empty, zero, malformed and unattributed deployments do not invent a recipient flash', () => {
  const invalidDeployments = [
    null, {}, { rune_e8: '100' }, { asset: ' ', rune_e8: '100' },
    { asset: 'BTC.BTC', rune_e8: '-1' }, { asset: 'ETH.ETH', rune_e8: 'invalid' },
    { asset: 'ZEC.ZEC', rune_e8: '0' }, { asset: 'XRP.XRP', rune_e8: '1.5' }
  ];
  for (const event of [null, {}, head([]), ...invalidDeployments.map(row => head([row]))]) {
    assert.equal(buildSystemIncomePolDeploymentPulse(event), null);
  }
});

test('unexpected multiple deployments are not combined or attributed to a single pool', () => {
  for (const secondAsset of ['BTC.BTC', 'ETH.ETH']) {
    assert.equal(buildSystemIncomePolDeploymentPulse(head([
      { asset: 'BTC.BTC', rune_e8: '100' }, { asset: secondAsset, rune_e8: '200' }
    ])), null);
  }
});

test('headline pulse renders one recipient with its full identifier and preserves its lifetime', async () => {
  const source = await readFile(new URL('../src/lib/SystemIncomePOL.svelte', import.meta.url), 'utf8');
  assert.match(source, /buildSystemIncomePolDeploymentPulse\(head\)/);
  assert.match(source, /RUNE → \{deploymentPulse\.label\}/);
  assert.match(source, /RUNE to \$\{deploymentPulse\.asset\}/);
  assert.doesNotMatch(source, /deploymentPulse\??\.pools/);
  assert.match(source, /title=\{deploymentPulseDetails\}/);
  assert.match(source, /aria-label=\{`New POL deployment: \$\{deploymentPulseDetails\}`\}/);
  assert.match(source, /if \(isNewHead && nextPulse\)/);
  assert.match(source, /if \(deploymentPulse\?\.height === head\.height\) deploymentPulse = null/);
  assert.match(source, /window\.setTimeout\([\s\S]*?, 1000\)/);
});
