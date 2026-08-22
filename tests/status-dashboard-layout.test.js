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
