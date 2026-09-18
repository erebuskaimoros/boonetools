import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only long-running processes need restarting for ordinary code changes.
// Oneshots resolve `current` when their existing timer next starts them.
const persistent = {
  'boonetools-api.service': 'backend/src/server.js',
  'boonetools-chain-stream-listener.service': 'backend/src/chain-stream-listener.js',
  'boonetools-financials.service': 'backend/src/financials-collector.js'
};
const endpointGroups = [
  [/pool-analysis/, ['pool-analysis']],
  [/financials/, ['financials']],
  [/pool-dislocation/, ['pool-dislocation']],
  [/burn-tracker/, ['burn-tracker']],
  [/system-income-pol/, ['pol-tracker']],
  [/pol-tracker/, ['pol-tvl']],
  [/status/, ['status', 'status-live']],
  [/treasury/, ['treasury']],
  [/node-vot/, ['node-votes']],
  [/rapid.swap/, ['rapid-swaps', 'rapid-market']],
  [/app-layer|rujira/, ['app-live', 'app-earnings', 'app-fees', 'app-reserve']],
  [/tc-fee/, ['tc-fee']]
];
const allChecks = [...new Set(endpointGroups.flatMap(([, names]) => names))].sort();

function files(root) {
  const result = new Map();
  function walk(relative) {
    const absolute = join(root, relative);
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (['node_modules', 'tests', '.git'].includes(entry.name)) continue;
      const name = join(relative, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) result.set(name, readFileSync(join(root, name)));
    }
  }
  for (const directory of ['backend/src', 'backend/data', 'backend/migrations', 'shared', 'ops/systemd', 'ops/docker']) walk(directory);
  for (const name of ['backend/package.json', 'backend/package-lock.json', 'scripts/boonetools-db-backup.sh', 'scripts/boonetools-db-migrate.sh']) {
    if (existsSync(join(root, name))) result.set(name, readFileSync(join(root, name)));
  }
  return result;
}

function dependencies(source, entry, visited = new Set()) {
  if (visited.has(entry)) return visited;
  visited.add(entry);
  // Conservative superset: includes imports, re-exports, literal dynamic imports,
  // and relative assets read with new URL(). No application code is executed.
  const text = source.get(entry)?.toString() || '';
  for (const match of text.matchAll(/['"`]((?:\.\.?\/)[^'"`\n]+)['"`]/g)) {
    dependencies(source, normalize(join(dirname(entry), match[1])), visited);
  }
  return visited;
}

export function buildPlan(previous, next) {
  const before = previous ? files(previous) : new Map();
  const after = files(next);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((name) => !before.has(name) || !after.has(name) || !before.get(name).equals(after.get(name)))
    .filter((name) => !/\.(md|test\.js)$/.test(name)).sort();
  for (const name of changed) {
    if (name.startsWith('backend/migrations/') && before.has(name)) {
      throw new Error(`Refusing rewritten or removed historical migration: ${name}`);
    }
  }
  const migrate = !previous || changed.some((name) => name.startsWith('backend/migrations/'));
  const coordinated = !previous || changed.some((name) => /^(backend\/(migrations\/|package[^/]*\.json)|ops\/|scripts\/boonetools-db-)/.test(name));
  const units = Object.keys(persistent).filter((unit) => after.has(`ops/systemd/${unit}`));
  const runtime = changed.filter((name) => /^(backend\/(src|data)\/|shared\/)/.test(name));
  // A new, unmapped asset or dependency manifest is safer with all persistent
  // consumers restarted. Scheduled jobs still do not need forced warmups.
  const unknown = runtime.some((name) => !/\.[cm]?js$/.test(name));
  const restart = units.filter((unit) => coordinated || unknown || [before, after].some((source) => {
    const reachable = dependencies(source, persistent[unit]);
    return runtime.some((name) => reachable.has(name));
  })).sort();
  let checks = runtime.flatMap((name) => endpointGroups.filter(([pattern]) => pattern.test(name)).flatMap(([, names]) => names));
  if (coordinated || unknown || runtime.some((name) => !endpointGroups.some(([pattern]) => pattern.test(name)))) checks = allChecks;
  return { mode: coordinated ? 'coordinated' : 'routine', migrate, restart, check: [...new Set(checks)].sort(), changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [previous, next] = process.argv.slice(2);
  if (!next) throw new Error('Usage: backend-deploy-plan.mjs PREVIOUS_RELEASE_OR_EMPTY NEXT_RELEASE');
  const plan = buildPlan(previous, next);
  console.log(`mode ${plan.mode}\nmigrate ${plan.migrate}`);
  for (const unit of plan.restart) console.log(`restart ${unit}`);
  for (const endpoint of plan.check) console.log(`check ${endpoint}`);
}
