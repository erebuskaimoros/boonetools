#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(
  await readFile(path.join(repoRoot, 'scripts/svelte-check-baseline.json'), 'utf8')
);
const binary = path.join(repoRoot, 'node_modules/.bin/svelte-check');
const result = spawnSync(binary, [
  '--tsconfig',
  './jsconfig.production.json',
  '--threshold',
  'error'
], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024
});

const output = `${result.stdout || ''}\n${result.stderr || ''}`;
const summary = output.match(/svelte-check found (\d+) errors? and (\d+) warnings?/);
if (!summary) {
  console.error(output.trim());
  console.error('Unable to read the svelte-check diagnostic summary.');
  process.exit(1);
}

const errors = Number(summary[1]);
const warnings = Number(summary[2]);
const failures = [];
if (errors > baseline.maximumErrors) {
  failures.push(`errors: ${errors} exceeds ${baseline.maximumErrors}`);
}
if (warnings > baseline.maximumWarnings) {
  failures.push(`warnings: ${warnings} exceeds ${baseline.maximumWarnings}`);
}

if (failures.length > 0) {
  console.error(output.trim());
  console.error('Svelte diagnostic budget regressed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`svelte-check production ratchet: ${errors} errors, ${warnings} warnings.`);
if (errors < baseline.maximumErrors || warnings < baseline.maximumWarnings) {
  console.log('Diagnostics improved; lower scripts/svelte-check-baseline.json in this change.');
}
