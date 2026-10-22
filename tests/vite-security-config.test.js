import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Vite defaults to a loopback-only development listener', async () => {
  const source = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(source, /server:\s*\{\s*(?:\/\/[^\n]*\n\s*)*host:\s*['"]127\.0\.0\.1['"]/);
});
