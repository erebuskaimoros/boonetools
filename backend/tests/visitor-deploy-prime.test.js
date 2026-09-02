import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const deploy = readFileSync(new URL('../../scripts/deploy-boonetools-backend-remote.sh', import.meta.url), 'utf8');
// Execute the real deployment functions, without its root-only activation driver.
const definitions = deploy.slice(deploy.indexOf('log() {'), deploy.lastIndexOf('\nrequire_safe_arguments\n'));
const optionalUnits = deploy.split('\n').find((line) => line.startsWith('OPTIONAL_PRIME_UNIT_PATTERN='));

function runPrime({ full = false, pendingUntil = 0, visitorFailures = 0, coreFails = false } = {}) {
  const result = spawnSync('bash', ['-s'], {
    encoding: 'utf8',
    timeout: 5_000,
    input: `set -euo pipefail
${optionalUnits}
${definitions}
clock=0
core_updated=-1000
available_at=${pendingUntil}
visitor_failures=${visitorFailures}
core_fails=${coreFails ? 1 : 0}
systemctl() {
  local action="$1" unit="$2"
  [[ "$action" == start ]] || return 0
  printf 'event|%s|start|%s\n' "$clock" "$unit"
  case "$unit" in
    boonetools-thornode-core-snapshot.service)
      [[ "$core_fails" -eq 0 ]] || return 1
      core_updated="$clock"
      ;;
    boonetools-app-layer-live-state.service)
      # Even an earlier App Layer warmup can outlive the 45-second core TTL.
      clock=$((clock + 50))
      ;;
    boonetools-rujira-base-fees.service|boonetools-node-votes-backfill.service|boonetools-treasury-snapshot.service)
      clock=$((clock + 180))
      ;;
    boonetools-visitor-data.service)
      printf 'event|%s|core_age|%s\n' "$clock" "$((clock - core_updated))"
      if [[ "$clock" -lt "$available_at" ]]; then
        printf 'event|%s|queue_not_due|%s\n' "$clock" "$available_at"
        return 1
      fi
      if [[ "$((clock - core_updated))" -ge 45 ]]; then
        available_at=$((clock + 60))
        printf 'event|%s|stale_core|%s\n' "$clock" "$available_at"
        return 1
      fi
      if [[ "$visitor_failures" -gt 0 ]]; then
        visitor_failures=$((visitor_failures - 1))
        available_at=$((clock + 60))
        printf 'event|%s|acquisition_failed|%s\n' "$clock" "$available_at"
        return 1
      fi
      printf 'event|%s|visitor_warmed|ok\n' "$clock"
      ;;
  esac
  return 0
}
sleep() {
  printf 'event|%s|sleep|%s\n' "$clock" "$1"
  clock=$((clock + $1))
}
${full ? 'prime_read_models' : 'prime_read_model_unit boonetools-visitor-data.service'}
`
  });
  assert.ifError(result.error);
  const events = result.stdout.split('\n').filter((line) => line.startsWith('event|')).map((line) => {
    const [, time, event, value] = line.split('|');
    return { time: Number(time), event, value };
  });
  return { ...result, events };
}

const visitorStarts = (result) => result.events.filter((row) => row.event === 'start' && row.value === 'boonetools-visitor-data.service');
const coreStarts = (result) => result.events.filter((row) => row.event === 'start' && row.value === 'boonetools-thornode-core-snapshot.service');
const diagnostics = (result) => `${result.stdout}\n${result.stderr}`;

test('deployment warms visitor globals with fresh core while timers are stopped and other primes run slowly', () => {
  const result = runPrime({ full: true });
  assert.equal(result.status, 0, diagnostics(result));
  assert.equal(visitorStarts(result).length, 1);
  assert.equal(result.events.filter((row) => row.event === 'visitor_warmed').length, 1);
  assert.ok(result.events.filter((row) => row.event === 'core_age').every((row) => Number(row.value) < 45));
});

test('visitor retry waits until an existing one-minute queue deferral is due', () => {
  const result = runPrime({ pendingUntil: 60 });
  assert.equal(result.status, 0, diagnostics(result));
  assert.equal(visitorStarts(result).length, 2, diagnostics(result));
  assert.equal(result.events.filter((row) => row.event === 'queue_not_due').length, 1);
  assert.equal(coreStarts(result).length, 2);
  assert.ok(visitorStarts(result)[1].time >= 60);
});

test('each visitor retry refreshes core after waiting for failed acquisitions to become due', () => {
  const result = runPrime({ visitorFailures: 2 });
  assert.equal(result.status, 0, diagnostics(result));
  assert.equal(visitorStarts(result).length, 3);
  assert.equal(coreStarts(result).length, 3);
  assert.equal(result.events.filter((row) => row.event === 'acquisition_failed').length, 2);
  assert.equal(result.events.filter((row) => row.event === 'queue_not_due').length, 0);
  assert.equal(result.events.filter((row) => row.event === 'stale_core').length, 0);
});

test('visitor warmup remains mandatory and stops after three failed acquisition attempts', () => {
  const result = runPrime({ visitorFailures: 99 });
  assert.equal(result.status, 1, diagnostics(result));
  assert.equal(visitorStarts(result).length, 3);
  assert.equal(result.events.filter((row) => row.event === 'acquisition_failed').length, 3, diagnostics(result));
  assert.equal(result.events.filter((row) => row.event === 'visitor_warmed').length, 0);
});

test('an unavailable core cannot make visitor freshness checks pass', () => {
  const result = runPrime({ coreFails: true });
  assert.equal(result.status, 1, diagnostics(result));
  assert.equal(coreStarts(result).length, 3, diagnostics(result));
  assert.equal(result.events.filter((row) => row.event === 'visitor_warmed').length, 0);
});
