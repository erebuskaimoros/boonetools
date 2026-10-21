import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// svelte-check switches to machine output when CLAUDECODE=1 (sveltejs/language-tools#2868),
// which drops the "svelte-check found N errors and M warnings" line this ratchet parses.
test('the Svelte diagnostic ratchet pins an output format that prints its summary line', async () => {
  const script = await readFile(new URL('../scripts/check-svelte-diagnostics.mjs', import.meta.url), 'utf8');
  assert.match(script, /'--output',\s*'human-verbose'/);
  assert.match(script, /svelte-check found \(\\d\+\) errors\?/);
});
