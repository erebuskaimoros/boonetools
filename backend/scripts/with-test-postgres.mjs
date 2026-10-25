#!/usr/bin/env node
/** Run migrated SQL checks against an owned, disposable native PostgreSQL cluster. */
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(`Usage: node backend/scripts/with-test-postgres.mjs [--migrate-only | -- command args...]

Creates a disposable native PostgreSQL cluster in a short, private /tmp directory,
applies every migration, and runs acquisition integration plus SQL price-bound checks.
Use -- to run a different command against the migrated cluster. The cluster is
stopped and removed on completion or failure. Existing databases are never used.
Set BOONETOOLS_PG_BIN to the directory containing matching PostgreSQL binaries
when they are not on PATH or in a standard Homebrew/Linux PostgreSQL directory.`);
  process.exit(0);
}
if (args.length && !(args.length === 1 && args[0] === '--migrate-only') && !(args[0] === '--' && args.length > 1)) {
  console.error('Invalid arguments. Use --help, --migrate-only, or -- command args...');
  process.exit(1);
}

function directoriesUnder(parent, predicate, suffix = '') {
  try { return readdirSync(parent).filter(predicate).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(name => join(parent, name, suffix)); }
  catch { return []; }
}

function postgresBinaries() {
  const candidates = process.env.BOONETOOLS_PG_BIN ? [resolve(process.env.BOONETOOLS_PG_BIN)] : [
    ...(process.env.PATH || '').split(delimiter),
    ...directoriesUnder('/opt/homebrew/opt', name => /^postgresql(?:@\d+)?$/.test(name), 'bin'),
    ...directoriesUnder('/usr/local/opt', name => /^postgresql(?:@\d+)?$/.test(name), 'bin'),
    ...directoriesUnder('/usr/lib/postgresql', name => /^\d+$/.test(name), 'bin')
  ];
  const directory = candidates.find(candidate => ['initdb', 'pg_ctl', 'createdb', 'psql'].every(binary => {
    try { accessSync(join(candidate, binary), constants.X_OK); return true; } catch { return false; }
  }));
  if (!directory) throw new Error('Native PostgreSQL tools were not found. Install PostgreSQL or set BOONETOOLS_PG_BIN to its bin directory.');
  return Object.fromEntries(['initdb', 'pg_ctl', 'createdb', 'psql'].map(binary => [binary, join(directory, binary)]));
}

let activeRun;
let interrupted;
function signalChild(child, signal) {
  // Include command grandchildren (for example npm's test workers).
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = signal;
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  activeRun?.stop();
});

async function run(command, commandArgs, env, timeout = 120000) {
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, commandArgs, { cwd: repoRoot, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stopping;
    const stop = () => {
      stopping ||= new Promise(resolveStopped => {
        signalChild(child, 'SIGTERM');
        // The direct child can exit before a worker that ignores SIGTERM.
        // Keep group escalation alive and wait for it before deleting the DB.
        setTimeout(() => {
          signalChild(child, 'SIGKILL');
          resolveStopped();
        }, 1000);
      });
      return stopping;
    };
    activeRun = { stop };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', async error => {
      clearTimeout(timer);
      if (stopping) await stopping;
      activeRun = null;
      reject(error);
    });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      if (stopping) await stopping;
      activeRun = null;
      if (code !== 0 || interrupted || timedOut) {
        reject(new Error(`${command} failed (${interrupted || (timedOut ? 'timeout' : signal || code)}).\n${stdout}${stderr}`));
      } else resolveRun({ stdout, stderr });
    });
  });
}

let binaries;
let clusterRoot;
let dataDir;
let serverLog;
let started = false;
try {
  binaries = postgresBinaries();
  // PostgreSQL Unix sockets have a short path limit on macOS. TMPDIR and deep
  // worktree names can exceed it, so use an independently owned short directory.
  clusterRoot = mkdtempSync('/tmp/bt-pg-');
  dataDir = join(clusterRoot, 'data');
  const socketDir = join(clusterRoot, 'socket');
  serverLog = join(clusterRoot, 'postgres.log');
  mkdirSync(socketDir, { mode: 0o700 });
  const port = String(randomInt(20000, 60000));
  const user = 'boonetools_test';
  const database = 'acquisition_test_local';
  const databaseUrl = `postgresql://${user}@localhost:${port}/${database}?host=${encodeURIComponent(socketDir)}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG') && !key.startsWith('BOONETOOLS_DB_')));
  Object.assign(env, {
    PATH: `${dirname(binaries.psql)}${delimiter}${env.PATH || ''}`,
    PGHOST: socketDir, PGPORT: port, PGUSER: user, PGDATABASE: database,
    PGCONNECT_TIMEOUT: '5', DATABASE_URL: databaseUrl, ACQUISITION_TEST_DATABASE_URL: databaseUrl,
    BOONETOOLS_DB_MODE: 'native', BOONETOOLS_PSQL_BIN: binaries.psql, BOONETOOLS_ENV_FILE: '/dev/null',
    BOONETOOLS_DB_MIGRATION_LOCK_FILE: join(clusterRoot, 'migrate.lock')
  });
  console.log('Initializing disposable PostgreSQL cluster...');
  await run(binaries.initdb, ['-D', dataDir, '-U', user, '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--locale=C'], env, 30000);
  started = true; // A partially successful pg_ctl start also needs cleanup.
  await run(binaries.pg_ctl, ['-D', dataDir, '-l', serverLog, '-w', '-t', '15', '-o',
    `-F -p ${port} -c listen_addresses='' -c unix_socket_directories='${socketDir}' -c timezone=UTC`, 'start'], env, 20000);
  await run(binaries.createdb, [database], env, 10000);
  console.log('Applying fresh-schema migrations...');
  const migration = await run('bash', [join(repoRoot, 'scripts/boonetools-db-migrate.sh')], env);
  console.log(`Applied ${(migration.stdout.match(/^Applying migration:/gm) || []).length} migrations.`);
  if (args[0] === '--') {
    const result = await run(args[1], args.slice(2), env);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } else if (args[0] !== '--migrate-only') {
    const integration = await run(process.execPath, [join(repoRoot, 'backend/scripts/check-acquisition-integration.mjs')], env);
    process.stdout.write(integration.stdout);
    process.stderr.write(integration.stderr);
    const bounds = await run(process.execPath, ['--test', join(repoRoot, 'backend/tests/base-fee-price-bounds.test.js')], env);
    process.stdout.write(bounds.stdout);
    process.stderr.write(bounds.stderr);
  }
  console.log('Disposable PostgreSQL checks passed.');
} catch (error) {
  console.error(error.message);
  if (serverLog && existsSync(serverLog)) console.error(`PostgreSQL startup/server log:\n${readFileSync(serverLog, 'utf8')}`);
  process.exitCode ||= 1;
} finally {
  let safeToRemove = true;
  if (started) {
    const stop = spawnSync(binaries.pg_ctl, ['-D', dataDir, '-w', '-t', '10', '-m', 'immediate', 'stop'], { encoding: 'utf8', timeout: 15000 });
    if (stop.status !== 0 && existsSync(join(dataDir, 'postmaster.pid'))) {
      safeToRemove = false;
      console.error(`PostgreSQL could not stop cleanly; preserving its files at ${clusterRoot}.\n${stop.stderr || stop.error || ''}`);
      process.exitCode ||= 1;
    }
  }
  if (clusterRoot && safeToRemove) rmSync(clusterRoot, { recursive: true, force: true });
}
