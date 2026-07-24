#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendRoot = path.join(repoRoot, 'backend');
const backendSourceRoot = path.join(backendRoot, 'src');
const allowedSharedRoots = [
  path.join(repoRoot, 'packages'),
  path.join(repoRoot, 'shared')
];
const importPattern = /(?:import|export)\s+(?:[^'"()]*?\sfrom\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

async function listJavaScriptFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(fullPath);
    return /\.(?:cjs|mjs|js)$/.test(entry.name) ? [fullPath] : [];
  }));
  return nested.flat();
}

async function resolveRelativeImport(importer, specifier) {
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, 'index.js')
  ];
  for (const candidate of candidates) {
    try {
      const details = await stat(candidate);
      if (details.isFile()) return candidate;
    } catch {
      // Keep trying extensions.
    }
  }
  return base;
}

function isWithin(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const violations = [];
const sourceRoots = [backendSourceRoot, ...allowedSharedRoots];
for (const sourceRoot of sourceRoots) {
  for (const file of await listJavaScriptFiles(sourceRoot)) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] || match[2];
      if (!specifier?.startsWith('.')) continue;

      const target = await resolveRelativeImport(file, specifier);
      const importerIsBackend = isWithin(file, backendRoot);
      const allowed = importerIsBackend
        ? isWithin(target, backendRoot) || allowedSharedRoots.some((root) => isWithin(target, root))
        : allowedSharedRoots.some((root) => isWithin(target, root));
      if (!allowed) {
        violations.push({
          file: path.relative(repoRoot, file),
          specifier,
          target: path.relative(repoRoot, target)
        });
      }
    }
  }
}

const deployScript = await readFile(path.join(repoRoot, 'scripts/deploy-boonetools-backend.sh'), 'utf8');
if (/\$ROOT\/src\//.test(deployScript)) {
  violations.push({
    file: 'scripts/deploy-boonetools-backend.sh',
    specifier: 'frontend source synchronization',
    target: 'src/lib'
  });
}

if (violations.length > 0) {
  console.error('Backend dependency-boundary violations:');
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.specifier} -> ${violation.target}`);
  }
  process.exit(1);
}

const smokeModules = [
  ['shared/rapid-swaps/backend.js', 'fetchRapidSwapRows', 'function'],
  ['shared/rapid-swaps/ingestion.js', 'buildRapidSwapCanonicalScanPlan', 'function'],
  ['shared/rapid-swaps/model.js', 'normalizeRapidSwapAction', 'function'],
  ['shared/rapid-swaps/reconciliation.js', 'normalizeRapidSwapHint', 'function'],
  ['shared/rapid-swaps/volume.js', 'getRapidSwapLegVolumeUsd', 'function'],
  ['shared/dynamic-fees/affiliate-volume.js', 'EXECUTED_LEG_VOLUME_BASIS', 'string'],
  ['backend/src/shared/rapid-swaps.js', 'fetchRapidSwapRows', 'function']
];

for (const [relativePath, expectedExport, expectedType] of smokeModules) {
  const module = await import(pathToFileURL(path.join(repoRoot, relativePath)).href);
  if (typeof module[expectedExport] !== expectedType) {
    throw new Error(`${relativePath} is missing ${expectedType} export ${expectedExport}`);
  }
}

console.log('Backend dependency boundary is clean.');
