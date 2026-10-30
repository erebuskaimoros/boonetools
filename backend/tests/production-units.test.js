import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

// Table-driven production wiring: a new job or unit is checked by these rules
// automatically, so features do not need their own deploy-script assertions.
const root = new URL('../../', import.meta.url);
const systemd = new URL('ops/systemd/', root);
const units = new Map(readdirSync(systemd).map((name) => [name, readFileSync(new URL(name, systemd), 'utf8')]));
const services = [...units.keys()].filter((name) => name.endsWith('.service'));
const timers = [...units.keys()].filter((name) => name.endsWith('.timer'));
const setting = (unit, key) => units.get(unit).match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1];

// run-job.js dispatches on argv when imported, so read its job table instead.
const registeredJobs = [...readFileSync(new URL('backend/src/run-job.js', root), 'utf8')
  .matchAll(/^ {2}'([a-z0-9-]+)': run\w+,?$/gm)].map(([, name]) => name);

test('every registered job has one service and every service starts an existing entry point', () => {
  assert.ok(registeredJobs.length > 0, 'expected to read the run-job.js job table');
  const scheduledJobs = [];
  for (const service of services) {
    const command = setting(service, 'ExecStart')?.split(' ');
    assert.ok(command, `${service} has no ExecStart`);
    const [, script, job] = command;
    if (script === 'src/run-job.js') scheduledJobs.push(job);
    const release = '/opt/boonetools-backend/current/';
    const file = script.startsWith(release) ? script.slice(release.length) : `backend/${script}`;
    assert.ok(existsSync(new URL(file, root)), `${service} starts missing ${file}`);
  }
  assert.deepEqual(scheduledJobs.sort(), [...registeredJobs].sort());
});

test('every deploy-managed unit follows the atomic current release and keeps durable state outside it', () => {
  for (const service of services) {
    const contents = units.get(service);
    assert.doesNotMatch(contents, /\/opt\/boonetools-backend\/(?:backend|scripts)/, service);
    assert.match(contents, /EnvironmentFile=\/opt\/boonetools-backend\/config\/backend\.env/, service);
    if (setting(service, 'ExecStart').startsWith('/usr/bin/node ')) {
      assert.equal(setting(service, 'WorkingDirectory'), '/opt/boonetools-backend/current/backend', service);
    }
    for (const [, directory] of contents.matchAll(/^Environment=\w+_CACHE_DIR=(.+)$/gm)) {
      assert.equal(directory, `/var/lib/${setting(service, 'StateDirectory')}`, `${service} cache must survive release rotation`);
    }
  }
  for (const timer of timers) {
    assert.doesNotMatch(units.get(timer), /^OnBootSec=/m, timer);
    assert.match(units.get(timer), /^(OnActiveSec|OnCalendar)=/m, timer);
    assert.ok(units.has(setting(timer, 'Unit') ?? timer.replace(/\.timer$/, '.service')), `${timer} triggers a missing unit`);
  }
});
