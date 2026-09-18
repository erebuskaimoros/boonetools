import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = readFileSync(new URL('../../scripts/deploy-boonetools-backend-remote.sh', import.meta.url), 'utf8');
const boundary = script.lastIndexOf('\nrequire_safe_arguments\n');
const definitions = script.slice(script.indexOf('log() {'), boundary);
const driver = script.slice(boundary);

function activate(t, { mode = 'routine', fail = '', extraActive = '', disabled = false, newTimer = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'boonetools-activate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = join(root, 'releases/previous');
  const release = join(root, 'releases/next');
  const current = join(root, 'current');
  for (const target of [previous, release]) {
    mkdirSync(join(target, 'ops'), { recursive: true });
    cpSync(new URL('../../ops/systemd', import.meta.url), join(target, 'ops/systemd'), { recursive: true });
  }
  symlinkSync(previous, current);
  if (newTimer) rmSync(join(previous, 'ops/systemd/boonetools-pool-analysis.timer'));
  const result = spawnSync('bash', ['-c', `set -euo pipefail
DEST="$TEST_ROOT"
RELEASES_DIR="$DEST/releases"
RELEASE_DIR="$RELEASES_DIR/next"
CURRENT_LINK="$DEST/current"
RELEASE_ID=next
PREVIOUS_TARGET="$RELEASES_DIR/previous"
ARCHIVE="$DEST/upload.tar.gz"
ENV_FILE="$DEST/env"
LOCK_FILE="$DEST/deploy.lock"
ROLLBACK_REQUIRED=false
MODE="$TEST_MODE"
MIGRATE=${fail === 'migration' ? 'true' : 'false'}
RESTART_UNITS=(boonetools-api.service)
CHECK_ENDPOINTS=(pool-analysis)
ACTIVE_UNITS=()
ENABLED_UNITS=()
STARTED_UNITS=()
${definitions}
record() { printf '%s\\n' "$*" >> "$TEST_ROOT/events"; }
require_safe_arguments() { :; }
flock() { :; }
prepare_server_config() { :; }
bootstrap_legacy_release() { :; }
validate_archive() { :; }
stage_release() { :; }
read_plan() { :; }
snapshot_unit_state() {
  ACTIVE_UNITS=(boonetools-api.service boonetools-chain-stream-listener.service boonetools-financials.service)
  if [[ "$DISABLED_TIMER" != true ]]; then ACTIVE_UNITS+=(boonetools-pool-analysis.timer); fi
  if [[ -n "$EXTRA_ACTIVE" ]]; then ACTIVE_UNITS+=("$EXTRA_ACTIVE"); fi
  ENABLED_UNITS=(boonetools-api.service boonetools-pool-analysis.timer)
}
installed_units() { printf '%s\\n' boonetools-api.service boonetools-financials.service boonetools-pool-analysis.timer boonetools-pool-analysis.service; }
install_units_from_release() { record "install $1"; }
start_postgres_and_wait() { record postgres; }
atomic_point_current() { record "switch $1"; rm -f "$CURRENT_LINK"; ln -s "$1" "$CURRENT_LINK"; }
cleanup_releases() { record cleanup; }
sleep() { :; }
curl() { [[ "$FAIL_MODE" != health || "$(readlink "$CURRENT_LINK")" != "$RELEASE_DIR" ]]; }
node() {
  record "check $*"
  if [[ "$FAIL_MODE" == checks && "$(readlink "$CURRENT_LINK")" == "$RELEASE_DIR" ]]; then return 1; fi
  return 0
}
systemctl() {
  record "systemctl $*"
  if [[ "$1" == restart && "$FAIL_MODE" == restart && "$(readlink "$CURRENT_LINK")" == "$RELEASE_DIR" ]]; then return 1; fi
  if [[ "$1" == restart && "$FAIL_MODE" == rollback ]]; then return 1; fi
  return 0
}
${driver}`], {
    encoding: 'utf8',
    env: { ...process.env, TEST_ROOT: root, TEST_MODE: mode, FAIL_MODE: fail, EXTRA_ACTIVE: extraActive, DISABLED_TIMER: String(disabled) }
  });
  return { ...result, events: readFileSync(join(root, 'events'), 'utf8'), previous, release };
}

test('routine activation leaves timers, backfills and unrelated services running', (t) => {
  const result = activate(t);
  assert.equal(result.status, 0, result.stderr);
  const mutations = result.events.split('\n').filter((line) => /systemctl (start|stop|restart|enable)/.test(line));
  assert.deepEqual(mutations, ['systemctl restart boonetools-api.service']);
  assert.doesNotMatch(result.events, /postgres|install /);
  assert.match(result.events, /--endpoint pool-analysis --health-only --allow-stale --require-compression/);
  assert.doesNotMatch(result.events, /--endpoint (status|treasury|financials)/);
});

test('coordinated deployment resumes active work but does not start inactive backfills or disabled timers', (t) => {
  const result = activate(t, { mode: 'coordinated', extraActive: 'boonetools-burn-tracker-backfill.service', disabled: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.events, /systemctl start --no-block boonetools-burn-tracker-backfill.service/);
  assert.doesNotMatch(result.events, /systemctl start.*boonetools-pool-analysis-backfill/);
  assert.doesNotMatch(result.events, /systemctl (start|enable).*boonetools-pool-analysis.timer/);
  assert.match(result.events, /postgres/);
});

for (const fail of ['restart', 'checks', 'health']) {
  test(`${fail} failure restores the previous release and affected service`, (t) => {
    const result = activate(t, { fail });
    assert.notEqual(result.status, 0);
    assert.notEqual(result.status, 70, result.stderr + result.events);
    assert.match(result.stderr, /Previous release restored and verified/);
    const switches = result.events.split('\n').filter((line) => line.startsWith('switch '));
    assert.deepEqual(switches, [`switch ${result.release}`, `switch ${result.previous}`]);
    assert.equal(result.events.split('\n').filter((line) => line === 'systemctl restart boonetools-api.service').length, 2);
    assert.doesNotMatch(result.events, /cleanup|systemctl restart.*financials/);
  });
}

test('rollback restart failures cannot be masked by later successful health checks', (t) => {
  const result = activate(t, { fail: 'rollback' });
  assert.equal(result.status, 70);
  assert.match(result.stderr, /CRITICAL/);
});

test('coordinated rollback restores the prior active and enabled unit sets', (t) => {
  const result = activate(t, { mode: 'coordinated', fail: 'checks' });
  assert.notEqual(result.status, 0);
  assert.notEqual(result.status, 70, result.stderr + result.events);
  assert.match(result.events, /systemctl enable boonetools-api.service boonetools-pool-analysis.timer/);
  assert.match(result.events, /systemctl restart boonetools-chain-stream-listener.service/);
  assert.match(result.events, /systemctl restart boonetools-financials.service/);
  assert.match(result.events, /systemctl start boonetools-pool-analysis.timer/);
});

test('coordinated activation enables a newly introduced timer, without waking manual backfills', (t) => {
  const result = activate(t, { mode: 'coordinated', disabled: true, newTimer: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.events, /systemctl enable boonetools-pool-analysis.timer/);
  assert.match(result.events, /systemctl start boonetools-pool-analysis.timer/);
  assert.doesNotMatch(result.events, /systemctl (start|restart).*backfill/);
});

test('migration failure before cutover resumes the previous services', (t) => {
  // The fixture deliberately has no migration runner, so the real invocation
  // fails before the current symlink is changed.
  const result = activate(t, { mode: 'coordinated', fail: 'migration' });
  assert.notEqual(result.status, 0);
  assert.notEqual(result.status, 70, result.stderr);
  assert.doesNotMatch(result.events, new RegExp(`switch ${result.release}`));
  assert.match(result.stderr, /Previous release restored and verified/);
});

test('a staged artifact can retry, but incomplete or mismatched release directories cannot be overwritten', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'boonetools-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'sentinel'), 'existing code');
  for (const recorded of [null, 'wrong', 'a'.repeat(64)]) {
    if (recorded !== null) writeFileSync(join(root, 'RELEASE'), `archive_sha256=${recorded}\n`);
    const result = spawnSync('bash', ['-c', `set -euo pipefail
RELEASE_DIR="$TEST_ROOT"
RELEASE_ID=example
EXPECTED_SHA256=${'a'.repeat(64)}
${definitions}
installed_release_target() { :; }
stage_release
`], { encoding: 'utf8', env: { ...process.env, TEST_ROOT: root } });
    assert.equal(result.status, recorded === 'a'.repeat(64) ? 0 : 1, result.stderr);
    assert.equal(readFileSync(join(root, 'sentinel'), 'utf8'), 'existing code');
  }
});

test('release retention recognizes a running process rooted in an older release', () => {
  const result = spawnSync('bash', ['-c', `set -euo pipefail
${definitions}
readlink() { printf '%s\\n' /opt/boonetools-backend/releases/old/backend; }
release_in_use /opt/boonetools-backend/releases/old
! release_in_use /opt/boonetools-backend/releases/unused
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
