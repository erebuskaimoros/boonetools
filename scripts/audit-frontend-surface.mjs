#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repoRoot, 'src');
const publicRoot = path.join(repoRoot, 'public');
const baselinePath = path.join(repoRoot, 'scripts/frontend-surface-baseline.json');
const checkMode = process.argv.includes('--check');
const sourceExtensions = new Set(['.js', '.mjs', '.ts', '.svelte']);
const importPattern = /(?:import|export)\s+(?:[^'"()]*?\sfrom\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  }));
  return nested.flat();
}

async function resolveSource(importer, specifier) {
  let base;
  if (specifier === '$lib') {
    base = path.join(sourceRoot, 'lib/index');
  } else if (specifier.startsWith('$lib/')) {
    base = path.join(sourceRoot, 'lib', specifier.slice('$lib/'.length));
  } else if (specifier.startsWith('.')) {
    base = path.resolve(path.dirname(importer), specifier);
  } else {
    return null;
  }

  const candidates = [
    base,
    ...[...sourceExtensions].map((extension) => `${base}${extension}`),
    ...[...sourceExtensions].map((extension) => path.join(base, `index${extension}`))
  ];
  for (const candidate of candidates) {
    try {
      const details = await stat(candidate);
      if (details.isFile() && candidate.startsWith(sourceRoot)) return candidate;
    } catch {
      // Try the next supported source form.
    }
  }
  return null;
}

const allSourceFiles = (await walkFiles(sourceRoot))
  .filter((file) => sourceExtensions.has(path.extname(file)));
const reachable = new Set();
const queue = [path.join(sourceRoot, 'main.js')];

while (queue.length > 0) {
  const file = queue.shift();
  if (reachable.has(file)) continue;
  reachable.add(file);
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const target = await resolveSource(file, match[1] || match[2]);
    if (target && !reachable.has(target)) queue.push(target);
  }
}

const unreachable = allSourceFiles.filter((file) => !reachable.has(file));
let unreachableLines = 0;
for (const file of unreachable) {
  const source = await readFile(file, 'utf8');
  unreachableLines += source === '' ? 0 : source.split(/\r?\n/).length;
}

let publicBytes = 0;
for (const file of await walkFiles(publicRoot)) {
  publicBytes += (await stat(file)).size;
}

const metrics = {
  reachableFiles: reachable.size,
  unreachableFiles: unreachable.length,
  unreachableLines,
  publicBytes
};

console.log(JSON.stringify(metrics, null, 2));
if (!checkMode) {
  for (const file of unreachable.sort()) {
    console.log(path.relative(repoRoot, file));
  }
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const failures = [];
for (const [metric, maximum] of Object.entries(baseline.maximums)) {
  if (metrics[metric] > maximum) {
    failures.push(`${metric}: ${metrics[metric]} exceeds ${maximum}`);
  }
}

if (failures.length > 0) {
  console.error('Frontend surface budget regressed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Frontend surface stays within its checked budget.');
