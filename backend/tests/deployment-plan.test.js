import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan } from '../../scripts/backend-deploy-plan.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'boonetools-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = join(root, 'before');
  const after = join(root, 'after');
  const put = (dir, file, text) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  for (const dir of [before, after]) {
    put(dir, 'backend/src/server.js', "import './handlers/pool-analysis.js'; import './handlers/financials.js';");
    put(dir, 'backend/src/handlers/pool-analysis.js', "import '../shared/pool-analysis.js';");
    put(dir, 'backend/src/handlers/financials.js', "import '../../../shared/financials/model.js';");
    put(dir, 'backend/src/shared/pool-analysis.js', 'export const version = 1;');
    put(dir, 'shared/financials/model.js', 'export const version = 1;');
    put(dir, 'backend/src/financials-collector.js', "import '../../shared/financials/model.js';");
    put(dir, 'backend/src/chain-stream-listener.js', 'export const version = 1;');
    for (const [name, entry] of [['api', 'server'], ['financials', 'financials-collector'], ['chain-stream-listener', 'chain-stream-listener']]) {
      put(dir, `ops/systemd/boonetools-${name}.service`, `[Service]\nType=simple\nExecStart=/usr/bin/node src/${entry}.js\n`);
    }
    put(dir, 'ops/systemd/boonetools-pool-analysis.service', '[Service]\nType=oneshot\nExecStart=/usr/bin/node src/run-job.js pool-analysis-scheduler\n');
    put(dir, 'ops/systemd/boonetools-pool-analysis.timer', '[Timer]\nOnUnitActiveSec=15min\n');
    put(dir, 'backend/migrations/001.sql', 'select 1;');
  }
  return { before, after, put };
}

test('a pool read-model change only restarts its persistent consumer; scheduled jobs keep their cadence', (t) => {
  const { before, after, put } = fixture(t);
  put(after, 'backend/src/shared/pool-analysis.js', 'export const version = 2;');
  const plan = buildPlan(before, after);
  assert.equal(plan.mode, 'routine');
  assert.deepEqual(plan.restart, ['boonetools-api.service']);
  assert.deepEqual(plan.check, ['pool-analysis']);
  assert.equal(plan.migrate, false);
});

test('shared financials calculations restart both API and collector, not the chain listener', (t) => {
  const { before, after, put } = fixture(t);
  put(after, 'shared/financials/model.js', 'export const version = 2;');
  assert.deepEqual(buildPlan(before, after).restart, ['boonetools-api.service', 'boonetools-financials.service']);
  assert.deepEqual(buildPlan(before, after).check, ['financials']);
});

test('removed imports are compared against both old and new dependency graphs', (t) => {
  const { before, after, put } = fixture(t);
  put(after, 'backend/src/server.js', 'export const version = 2;');
  rmSync(join(after, 'backend/src/handlers/pool-analysis.js'));
  const plan = buildPlan(before, after);
  assert.ok(plan.restart.includes('boonetools-api.service'));
  assert.ok(plan.check.includes('pool-analysis'));
});

test('schema, dependencies, and unit manifests require coordination; only new migrations invoke migrate', (t) => {
  for (const [file, migrate] of [['backend/migrations/002.sql', true], ['backend/package-lock.json', false], ['ops/systemd/boonetools-new.timer', false]]) {
    const { before, after, put } = fixture(t);
    put(after, file, 'new');
    const plan = buildPlan(before, after);
    assert.equal(plan.mode, 'coordinated', file);
    assert.equal(plan.migrate, migrate, file);
    assert.equal(plan.restart.length, 3);
  }
});

test('rewritten or removed historical migrations are rejected before stopping services', (t) => {
  const { before, after, put } = fixture(t);
  put(after, 'backend/migrations/001.sql', 'select 2;');
  assert.throws(() => buildPlan(before, after), /historical migration/);
  rmSync(join(after, 'backend/migrations/001.sql'));
  assert.throws(() => buildPlan(before, after), /historical migration/);
});

test('unknown runtime files use conservative restarts; docs and tests do not restart services', (t) => {
  const { before, after, put } = fixture(t);
  put(after, 'backend/tests/example.test.js', 'test');
  put(after, 'scripts/deploy-boonetools-backend-remote.sh', '# new deploy driver');
  assert.deepEqual(buildPlan(before, after).restart, []);
  put(after, 'backend/data/new.json', '{}');
  assert.equal(buildPlan(before, after).restart.length, 3);
});

test('the production dependency graph scopes the Financials and Pool Analysis patches correctly', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'boonetools-real-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = new URL('../../', import.meta.url).pathname;
  for (const file of ['shared/financials/model.js', 'backend/src/shared/pool-analysis-ingestion.js']) {
    const after = join(root, file.replaceAll('/', '-'));
    for (const directory of ['backend/src', 'backend/data', 'backend/migrations', 'shared', 'ops']) {
      cpSync(join(before, directory), join(after, directory), { recursive: true });
    }
    // Keep dependency manifests equal, without copying node_modules.
    for (const name of ['package.json', 'package-lock.json']) cpSync(join(before, 'backend', name), join(after, 'backend', name));
    mkdirSync(join(after, 'scripts'), { recursive: true });
    for (const name of ['boonetools-db-backup.sh', 'boonetools-db-migrate.sh']) cpSync(join(before, 'scripts', name), join(after, 'scripts', name));
    writeFileSync(join(after, file), '// changed for deployment test\n', { flag: 'a' });
    const plan = buildPlan(before, after);
    assert.equal(plan.mode, 'routine');
    assert.ok(!plan.restart.includes('boonetools-chain-stream-listener.service'));
    assert.ok(plan.check.includes(file.includes('financials') ? 'financials' : 'pool-analysis'));
  }
});

test('every persistent production unit is represented in the restart planner', () => {
  const root = new URL('../../', import.meta.url).pathname;
  const expected = readdirSync(join(root, 'ops/systemd')).filter((name) =>
    name.endsWith('.service') && /^Type=(simple|exec|notify)$/m.test(readFileSync(join(root, 'ops/systemd', name), 'utf8'))
  ).sort();
  assert.deepEqual(buildPlan('', root).restart, expected);
});
