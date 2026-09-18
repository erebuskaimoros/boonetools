import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

test('Vite comparison plugin loads without backend-only packages or production configuration', async () => {
  // The frontend deployment installs only the root package-lock, unlike CI's
  // combined frontend/backend checkout. Trace the actual bundled config edge.
  const result = await build({ entryPoints: ['scripts/dev-protocol-fee-comparison.mjs'],
    bundle: true, platform: 'node', format: 'esm', packages: 'external',
    metafile: true, write: false });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(!inputs.some(file => /backend\/src\/(?:lib\/config|db\/pool|shared\/provider-cooldown)\.js$/.test(file)),
    `Dev plugin loads backend runtime modules: ${inputs.filter(file => /config|pool|cooldown/.test(file)).join(', ')}`);
  const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports.map(entry => entry.path));
  assert.ok(!imports.includes('dotenv'));
  assert.ok(!imports.includes('pg'));
});
