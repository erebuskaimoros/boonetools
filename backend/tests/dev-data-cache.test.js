import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDevDataCache } from '../../scripts/dev-data-cache.mjs';
import { createFinancialsDevPlugin } from '../../scripts/dev-financials.mjs';
import { comparisonCacheFile } from '../../scripts/dev-protocol-fee-comparison.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'boonetools-dev-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function store(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

const samples = [
  ['financials/history-v1.json', '{\n "version": 1, "swaps": {}, "earnings": {}, "bonds": {}, "note": "retained bytes ✓"\n}\n'],
  ['protocol-fee-comparison/state.json', '{\n "cache": {"version":1,"days":{"2026-09-18":{"nearRevenue":123}},"boundaries":{}}, "payload": null\n}\n']
];

test('development caches live outside the npm install tree', async t => {
  assert.equal(path.relative(root, comparisonCacheFile), '.boonetools-cache/protocol-fee-comparison/state.json');

  const directory = await fixture(t);
  const hourly = '{"version":1,"swaps":{},"earnings":{}}';
  await store(path.join(directory, 'node_modules', '.cache', samples[0][0]), samples[0][1]);
  await store(path.join(directory, 'node_modules', '.cache', 'financials', 'hourly-v1.json'), hourly);
  // Stub acquisition so the Financials plugin exercises only cache placement, never live providers.
  const created = [];
  const service = ({ cacheDir }) => { created.push(cacheDir); return { stop: async () => {} }; };
  const plugin = createFinancialsDevPlugin({ root: directory, days: { start() {}, stop: async () => {} },
    createService: service, createHourlyService: service });
  await plugin.configureServer({ middlewares: { use() {} } });
  const durable = path.join(directory, '.boonetools-cache', 'financials');
  assert.equal(await readFile(path.join(durable, 'history-v1.json'), 'utf8'), samples[0][1]);
  assert.equal(await readFile(path.join(durable, 'hourly-v1.json'), 'utf8'), hourly);
  assert.deepEqual(created, [durable, durable]);
  await plugin.closeBundle();
});

for (const [relativeFile, bytes] of samples) {
  test(`${relativeFile}: migration retains exact bytes and survives npm-tree removal`, async t => {
    const directory = await fixture(t);
    const legacy = path.join(directory, 'node_modules', '.cache', relativeFile);
    await store(legacy, bytes);
    const cache = createDevDataCache(relativeFile, { root: directory });
    assert.equal(await cache.prepare(), cache.file);
    assert.equal(await readFile(cache.file, 'utf8'), bytes);
    assert.equal(await readFile(legacy, 'utf8'), bytes, 'migration must leave the legacy copy intact');
    await rm(path.join(directory, 'node_modules'), { recursive: true });
    assert.equal(await readFile(cache.file, 'utf8'), bytes);
    assert.equal(await createDevDataCache(relativeFile, { root: directory }).prepare(), cache.file);
  });
}

test('an existing durable cache wins without reading or overwriting older legacy bytes', async t => {
  const directory = await fixture(t);
  const relativeFile = samples[0][0];
  const cache = createDevDataCache(relativeFile, { root: directory });
  const legacy = path.join(directory, 'node_modules', '.cache', relativeFile);
  const current = JSON.stringify({ generation: 'newer durable' });
  await store(cache.file, current);
  await store(legacy, 'invalid older legacy bytes');
  await cache.prepare();
  assert.equal(await readFile(cache.file, 'utf8'), current);
  assert.equal(await readFile(legacy, 'utf8'), 'invalid older legacy bytes');
});

test('invalid durable data is preserved and never replaced by valid older data', async t => {
  const directory = await fixture(t);
  const relativeFile = samples[0][0];
  const cache = createDevDataCache(relativeFile, { root: directory });
  const legacy = path.join(directory, 'node_modules', '.cache', relativeFile);
  await store(legacy, samples[0][1]);
  await store(cache.file, 'truncated newer cache');
  await assert.rejects(cache.prepare(), /Cannot use development cache/);
  assert.equal(await readFile(cache.file, 'utf8'), 'truncated newer cache');
  assert.equal(await readFile(legacy, 'utf8'), samples[0][1]);
});
