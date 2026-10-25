import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

function sourceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'boonetools-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gitBinary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const git = (...args) => execFileSync(gitBinary, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'bin'));
  for (const name of ['require-canonical-boonetools-repo.sh', 'deploy-boonetools-backend.sh', 'deploy-boonetools-frontend.sh', 'load-boonetools-frontend-env.sh']) {
    copyFileSync(new URL(`../../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
  }
  for (const dir of ['backend', 'shared', 'ops']) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, 'sentinel.txt'), 'committed source');
  }
  for (const kind of ['backend', 'frontend']) writeFileSync(join(root, `scripts/deploy-boonetools-${kind}-remote.sh`), '# committed remote helper\n');
  git('init', '-b', 'main');
  git('config', 'user.name', 'Deployment Test');
  git('config', 'user.email', 'test@example.invalid');
  git('add', 'scripts', 'backend', 'shared', 'ops');
  git('commit', '-m', 'verified source');
  const sha = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', 'https://github.com/erebuskaimoros/boonetools.git');
  git('branch', 'production-main');
  git('checkout', '-b', 'unrelated-local-work');
  const putBin = (name, text) => writeFileSync(join(root, 'bin', name), '#!/usr/bin/env bash\nset -eu\n' + text, { mode: 0o755 });
  putBin('git', `if [[ "$*" == *'fetch --quiet origin main' ]]; then exec '${gitBinary}' -C "$TEST_ROOT" fetch --quiet . production-main; fi\nexec '${gitBinary}' "$@"\n`);
  putBin('gh', `printf '%s\\n' "$*" >> "$TEST_ROOT/ci-calls"\nprintf '%s\\n' "$CI_RESULT"\n`);
  putBin('scp', `cp "$1" "$TEST_ROOT/upload.tar.gz"\n`);
  putBin('ssh', `if [[ "$*" == *'cat /opt/boonetools-frontend/config/sto-widget-api-key'* ]]; then
    touch "$TEST_ROOT/read-widget-key"
    [[ "\${TEST_STO_READ_FAIL:-}" != 1 ]] || exit 1
    printf '%s' "$TEST_STO_KEY"
  elif [[ "$*" == *'bash -s'* ]]; then /bin/cat > "$TEST_ROOT/executed-helper"; fi\n`);
  putBin('npm', `test ! -e .env\ntest "$(cat backend/sentinel.txt)" = 'committed source'\ntest "$VITE_STO_WIDGET_API_KEY" = "$EXPECTED_STO_KEY"\nif [[ "$*" == 'run build' ]]; then mkdir dist; printf '<html>committed build</html>' > dist/index.html; if [[ "\${TEST_ADD_XATTR:-0}" == 1 ]]; then /usr/bin/xattr -w com.boonetools.packaging-test metadata-must-not-ship dist/index.html; fi; fi\n`);
  const run = (script, args = [sha], env = {}) => spawnSync('bash', [join(root, 'scripts', script), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TEST_ROOT: root, CI_RESULT: 'success',
      VITE_STO_WIDGET_API_KEY: '', TEST_STO_KEY: 'test-sto-key', EXPECTED_STO_KEY: 'test-sto-key', ...env }
  });
  return { root, git, sha, run };
}

function assertCleanFrontendArtifact(root) {
  const archive = gunzipSync(readFileSync(join(root, 'upload.tar.gz'))).toString('latin1');
  assert.equal(/LIBARCHIVE\.xattr|SCHILY\.xattr|metadata-must-not-ship|\.\/\._/.test(archive), false,
    'Frontend artifact must not contain xattr headers, metadata, or AppleDouble entries');
  const packed = execFileSync('tar', ['-xOzf', join(root, 'upload.tar.gz'), './index.html'], { encoding: 'utf8' });
  assert.equal(packed, '<html>committed build</html>');
}

test('macOS frontend artifacts exclude extended attributes without losing built content', { skip: process.platform !== 'darwin' }, (t) => {
  const { root, run } = sourceFixture(t);
  const result = run('deploy-boonetools-frontend.sh', undefined, { TEST_ADD_XATTR: '1' });
  assert.equal(result.status, 0, result.stderr);
  assertCleanFrontendArtifact(root);
});

test('frontend packaging remains compatible with GNU tar', (t) => {
  const gnuTar = ['tar', 'gtar'].find((candidate) => {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    return result.status === 0 && /GNU tar/.test(result.stdout);
  });
  if (!gnuTar) return t.skip('GNU tar is not installed');
  const { root, run } = sourceFixture(t);
  const tarBinary = execFileSync('which', [gnuTar], { encoding: 'utf8' }).trim();
  symlinkSync(tarBinary, join(root, 'bin/tar'));
  const result = run('deploy-boonetools-frontend.sh', undefined,
    { TEST_ADD_XATTR: process.platform === 'darwin' ? '1' : '0' });
  assert.equal(result.status, 0, result.stderr);
  assertCleanFrontendArtifact(root);
});

for (const kind of ['backend', 'frontend']) {
  test(`${kind} deploy excludes dirty sources and executes the helper from the selected CI-passing SHA`, (t) => {
    const { root, sha, run, git } = sourceFixture(t);
    writeFileSync(join(root, 'backend/sentinel.txt'), 'dirty source must not ship');
    writeFileSync(join(root, '.env'), 'VITE_TEST=local-only');
    writeFileSync(join(root, `scripts/deploy-boonetools-${kind}-remote.sh`), '# dirty helper must not execute');
    writeFileSync(join(root, 'scripts/load-boonetools-frontend-env.sh'), 'exit 99 # dirty config loader must not execute');
    const before = git('diff');
    const result = run(`deploy-boonetools-${kind}.sh`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'executed-helper'), 'utf8'), '# committed remote helper\n');
    const packed = execFileSync('tar', ['-xOzf', join(root, 'upload.tar.gz'), kind === 'backend' ? 'backend/sentinel.txt' : './index.html'], { encoding: 'utf8' });
    assert.equal(packed, kind === 'backend' ? 'committed source' : '<html>committed build</html>');
    assert.match(readFileSync(join(root, 'ci-calls'), 'utf8'), new RegExp(`/commits/${sha}/check-runs`));
    assert.equal(git('diff'), before);
    assert.equal(git('branch', '--show-current'), 'unrelated-local-work');
  });
}

test('failed/missing/pending CI and unpublished commits fail closed, including old bypass variables', (t) => {
  const { root, run, git } = sourceFixture(t);
  for (const CI_RESULT of ['failure', '', 'null']) {
    const result = run('deploy-boonetools-backend.sh', undefined, { CI_RESULT, BOONETOOLS_SKIP_CI_CHECK: 'true', BOONETOOLS_ALLOW_UNVERIFIED_SOURCE: 'true' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not successful/);
  }
  writeFileSync(join(root, 'backend/sentinel.txt'), 'unpublished');
  git('add', 'backend');
  git('commit', '-m', 'not on main');
  const result = run('deploy-boonetools-backend.sh', ['HEAD']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not on production main/);
});

test('frontend deploy reuses the server key without printing it and supports an explicit override', (t) => {
  const { root, run } = sourceFixture(t);
  const result = run('deploy-boonetools-frontend.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, 'read-widget-key')), true);
  assert.doesNotMatch(result.stdout + result.stderr, /test-sto-key/);
  rmSync(join(root, 'read-widget-key'));
  const override = run('deploy-boonetools-frontend.sh', undefined, {
    VITE_STO_WIDGET_API_KEY: 'override-key', EXPECTED_STO_KEY: 'override-key', TEST_STO_READ_FAIL: '1'
  });
  assert.equal(override.status, 0, override.stderr);
  assert.equal(existsSync(join(root, 'read-widget-key')), false);
  assert.doesNotMatch(override.stdout + override.stderr, /override-key/);
});

test('frontend deploy fails before upload when the widget key is missing or malformed', (t) => {
  const { root, run } = sourceFixture(t);
  for (const env of [{ TEST_STO_READ_FAIL: '1' }, { TEST_STO_KEY: '' }, { TEST_STO_KEY: 'invalid key' }]) {
    const result = run('deploy-boonetools-frontend.sh', undefined, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Deploy aborted:.*STO widget key/);
    assert.equal(existsSync(join(root, 'upload.tar.gz')), false);
    assert.doesNotMatch(result.stdout + result.stderr, /invalid key/);
  }
});

test('frontend rollback targets without a widget loader still build', (t) => {
  const { root, run, git } = sourceFixture(t);
  git('rm', 'scripts/load-boonetools-frontend-env.sh');
  git('commit', '-m', 'release without widget configuration');
  git('branch', '-f', 'production-main', 'HEAD');
  const result = run('deploy-boonetools-frontend.sh', ['HEAD'], { EXPECTED_STO_KEY: '', TEST_STO_READ_FAIL: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, 'read-widget-key')), false);
});

test('a commit argument is mandatory and the canonical origin is still enforced', (t) => {
  const { run, git } = sourceFixture(t);
  assert.equal(run('deploy-boonetools-backend.sh', []).status, 2);
  git('remote', 'set-url', 'origin', 'https://example.invalid/other.git');
  const result = run('deploy-boonetools-backend.sh');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canonical BooneTools remote/);
});
