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
    pools: [{ asset, label: 'TRON.USDT', runeE8: '6000000' }]
  });
});

test('multi-pool blocks group repeated recipients and keep chains distinct with exact sums', () => {
  const event = head([
    { asset: 'TRON.USDT-TOKEN', rune_e8: '9007199254740993' },
    { asset: 'BSC.USDT-TOKEN', rune_e8: '100000000' },
    { asset: 'TRON.USDT-TOKEN', rune_e8: '7' }
  ]);
  const original = structuredClone(event);
  assert.deepEqual(buildSystemIncomePolDeploymentPulse(event), {
    height: 101,
    runeE8: '9007199354741000',
    pools: [
      { asset: 'BSC.USDT-TOKEN', label: 'BSC.USDT', runeE8: '100000000' },
      { asset: 'TRON.USDT-TOKEN', label: 'TRON.USDT', runeE8: '9007199254741000' }
    ]
  });
  assert.deepEqual(event, original);
});

test('pulse uses the normalized live-stream pool and amount aliases', () => {
  const event = parseChainHeadEvent({
    height: 101, time: '2026-10-23T12:00:00Z',
    pol_reserve_deployments: [{ pool: 'ZEC.ZEC', rune_amount_e8: '12345678' }]
  });
  assert.deepEqual(buildSystemIncomePolDeploymentPulse(event)?.pools, [
    { asset: 'ZEC.ZEC', label: 'ZEC.ZEC', runeE8: '12345678' }
  ]);
});

test('empty, zero, malformed and unattributed deployments do not invent a recipient flash', () => {
  for (const event of [null, {}, head([]), head([
    null, {}, { rune_e8: '100' }, { asset: 'BTC.BTC', rune_e8: '-1' },
    { asset: 'ETH.ETH', rune_e8: 'invalid' }, { asset: 'ZEC.ZEC', rune_e8: '0' }
  ])]) assert.equal(buildSystemIncomePolDeploymentPulse(event), null);
});

test('headline pulse renders recipients with accessible full identifiers and preserves its lifetime', async () => {
  const source = await readFile(new URL('../src/lib/SystemIncomePOL.svelte', import.meta.url), 'utf8');
  assert.match(source, /buildSystemIncomePolDeploymentPulse\(head\)/);
  assert.match(source, /deploymentPulse\.pools\.map\(pool => pool\.label\)\.join\(', '\)/);
  assert.match(source, /title=\{deploymentPulseDetails\}/);
  assert.match(source, /aria-label=\{`New POL deployment: \$\{deploymentPulseDetails\}`\}/);
  assert.match(source, /if \(isNewHead && nextPulse\)/);
  assert.match(source, /if \(deploymentPulse\?\.height === head\.height\) deploymentPulse = null/);
  assert.match(source, /window\.setTimeout\([\s\S]*?, 1000\)/);
});
