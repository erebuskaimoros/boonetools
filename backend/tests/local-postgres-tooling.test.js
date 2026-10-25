import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const migrationRunner = fileURLToPath(new URL('../../scripts/boonetools-db-migrate.sh', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bt-pg-tool-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['scripts', 'backend/migrations', 'bin']) mkdirSync(join(root, directory), { recursive: true });
  copyFileSync(migrationRunner, join(root, 'scripts/boonetools-db-migrate.sh'));
  writeFileSync(join(root, 'backend/migrations/001_fixture.sql'), 'begin;\nselect 42;\ncommit;\n');
  writeFileSync(join(root, 'backend/.env'), 'BOONETOOLS_DB_PASSWORD=must-not-load-implicitly\n');
  const log = join(root, 'calls.log');
  const executable = (name, body) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  executable('psql', `printf 'PSQL %s PASSWORD=%s\\n' "$*" "\${PGPASSWORD-}" >> "$TEST_CALL_LOG"\ncat >> "$TEST_CALL_LOG"`);
  executable('docker', `printf 'DOCKER %s\\n' "$*" >> "$TEST_CALL_LOG"\ncat >> "$TEST_CALL_LOG"`);
  const env = { ...process.env, PATH: `${join(root, 'bin')}:/usr/bin:/bin`, TEST_CALL_LOG: log,
    BOONETOOLS_DB_MODE: 'native', BOONETOOLS_PSQL_BIN: join(root, 'bin/psql'),
    PGHOST: '/tmp/fixture-socket', PGPORT: '55545', PGDATABASE: 'acquisition_test_fixture', PGUSER: 'fixture',
    TMPDIR: root };
  for (const name of ['BOONETOOLS_ENV_FILE', 'BOONETOOLS_DB_PASSWORD', 'BOONETOOLS_DB_NAME', 'BOONETOOLS_DB_USER', 'BOONETOOLS_DB_MIGRATION_LOCK_FILE', 'PGPASSWORD']) delete env[name];
  return { root, log, env };
}

test('Docker remains the default migration transport', t => {
  const { root, log, env } = fixture(t);
  delete env.BOONETOOLS_DB_MODE;
  env.BOONETOOLS_DB_MIGRATION_LOCK_FILE = join(root, 'docker-migrate.lock');
  env.BOONETOOLS_ENV_FILE = '/dev/null';
  env.BOONETOOLS_DB_PASSWORD = 'fixture-only';
  const result = spawnSync('bash', [join(root, 'scripts/boonetools-db-migrate.sh')], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(log, 'utf8'), /DOCKER exec -i boonetools-postgres env PGPASSWORD=fixture-only psql/);
});

test('native migrations require an explicit database and honor BOONETOOLS_DB_NAME', t => {
  const { root, log, env } = fixture(t);
  delete env.PGDATABASE;
  const missingTarget = spawnSync('bash', [join(root, 'scripts/boonetools-db-migrate.sh')], { env, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(missingTarget.status, 0, missingTarget.stdout + missingTarget.stderr);
  assert.match(missingTarget.stderr, /BOONETOOLS_DB_NAME.*PGDATABASE/);
  assert.equal(existsSync(log), false, 'An unspecified target must never invoke psql');

  env.BOONETOOLS_DB_NAME = 'acquisition_test_explicit';
  const explicitTarget = spawnSync('bash', [join(root, 'scripts/boonetools-db-migrate.sh')], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(explicitTarget.status, 0, explicitTarget.stderr);
  assert.match(readFileSync(log, 'utf8'), /PSQL .* -d acquisition_test_explicit/);
});
