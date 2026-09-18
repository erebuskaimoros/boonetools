import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const smoke = new URL('../../scripts/perf-smoke.mjs', import.meta.url).pathname;

async function check(t, { code = 200, contentType = 'application/json', stale = true, healthOnly = true } = {}) {
  const server = createServer((request, response) => {
    response.writeHead(code, { 'Content-Type': contentType, 'X-Boone-Read-Model-Stale': stale ? '1' : '0' });
    response.end(JSON.stringify({ data: 'x'.repeat(40_000) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const args = [smoke, '--base', `http://127.0.0.1:${server.address().port}`, '--endpoint', 'status', '--allow-stale'];
  if (healthOnly) args.push('--health-only');
  try { return { ...(await run(process.execPath, args)), code: 0 }; }
  catch (error) { return error; }
}

test('deploy health checks warn about stale caches without gating on performance budgets', async (t) => {
  const result = await check(t);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /cached data is stale/);
});

test('explicit performance smoke still enforces the normal payload budget', async (t) => {
  const result = await check(t, { healthOnly: false });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /bytes > 25000/);
});

test('health-only still rejects broken HTTP routes and non-JSON responses', async (t) => {
  for (const options of [{ code: 503 }, { contentType: 'text/html' }]) {
    const result = await check(t, options);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /non-2xx|not JSON/);
  }
});
