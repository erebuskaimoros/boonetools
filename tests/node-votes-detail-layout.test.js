import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../src/lib/NodeVotes.svelte', import.meta.url),
  'utf8'
);

test('expanded vote details give Node Votes more desktop width than Effective Value History', () => {
  const detailGridRule = source.match(
    /\.detail-grid\s*\{[^}]*grid-template-columns:\s*minmax\((\d+)px,\s*([\d.]+)fr\)\s+minmax\((\d+)px,\s*([\d.]+)fr\)/
  );

  assert.ok(detailGridRule, 'expected the desktop detail grid to use two bounded fractional tracks');

  const [, nodeMin, nodeShare, historyMin, historyShare] = detailGridRule.map(Number);
  assert.ok(nodeMin > historyMin, 'Node Votes should have the larger minimum track width');
  assert.ok(nodeShare > historyShare, 'Node Votes should receive the larger share of available width');
});

test('expanded vote details still stack at the mobile breakpoint', () => {
  assert.match(
    source,
    /@media \(max-width:\s*900px\)[\s\S]*?\.detail-grid\s*\{\s*grid-template-columns:\s*1fr;/
  );
});
