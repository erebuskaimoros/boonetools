import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../src/lib/StatusDashboard.svelte', import.meta.url),
  'utf8'
);

test('long network-change vote keys stay inside their dashboard card', () => {
  assert.match(source, /class="update-key"[^>]*title=/);
  assert.match(source, /\.timeline-content > div \{[^}]*min-width:\s*0/);
  assert.match(source, /\.timeline-content strong \{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/);
  assert.match(source, /\.update-key \{[^}]*max-width:[^;}]+[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/);
});

test('a consensus stall is unmistakable before configured chain availability', () => {
  assert.match(source, /consensusStalled\s*=\s*networkConsensus\.state\s*===\s*'stalled'/);
  assert.match(source, /\{#if consensusStalled\}[\s\S]*class="alert err stall-alert"[^>]*role="alert"/);
  assert.match(source, /Block production is stalled/);
  assert.match(source, /No THORChain block has committed for/);
  assert.match(source, /Validators may still be signing consensus votes/);
  assert.match(source, /no proposed block is reaching commit quorum/);
  assert.match(source, /On-chain actions cannot progress until consensus resumes/);
  assert.match(source, /Mimir and configured chain lanes below can still show ENABLED/);
  assert.match(source, /<th>Outbound Signing<\/th>/);
  assert.match(source, /reports TSS\/config state, not block-finalization health/);
  assert.ok(
    source.indexOf('class="alert err stall-alert"') < source.indexOf('class="overview-grid"'),
    'stall alert should appear before the normal network overview'
  );
});

test('stalled block timing replaces false live indicators', () => {
  assert.match(source, /no new block for \{formatDurationSeconds\(networkConsensus\.block_age_seconds\)\}/);
  assert.match(source, /class:stalled=\{consensusStalled\}/);
  assert.match(source, /\{consensusStalled \? 'NO NEW BLOCKS' : 'LIVE'\}/);
  assert.match(source, /\.source-line\.stalled i \{[^}]*animation:\s*none/);
});

test('chain availability shows average active-validator lag behind each reported tip', () => {
  assert.match(source, /<th[^>]*>Avg Blocks Behind Tip<\/th>/);
  assert.match(source, /formatAverageBlockLag\(chain\)/);
  assert.match(source, /Mean lag across/);
  assert.match(source, /reported tip/);
  assert.match(source, /\.lag \{[^}]*color:\s*var\(--term-text-strong,\s*#fff\)/);
});
