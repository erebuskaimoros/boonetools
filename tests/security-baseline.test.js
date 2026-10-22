import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const minimums = {
  // October 2026 advisory baseline. Check nested copies as well as direct deps.
  vite: [7, 3, 7],
  svelte: [5, 55, 7],
  axios: [1, 20, 0],
  protobufjs: [7, 6, 5],
  tar: [7, 5, 22]
};

for (const [name, minimum] of Object.entries(minimums)) {
  test(`${name} lockfile copies meet the reviewed security baseline`, () => {
    const copies = Object.entries(lock.packages).filter(([location]) =>
      location.endsWith(`/node_modules/${name}`) || location === `node_modules/${name}`);
    // A dependency may disappear entirely after its parent is updated.
    for (const [location, entry] of copies) {
      assert.match(entry.version, /^\d+\.\d+\.\d+$/, `${location}: require a stable version`);
      const parts = entry.version.split('.').map(Number);
      const comparison = parts.reduce((result, value, index) => result || Math.sign(value - minimum[index]), 0);
      assert.ok(comparison >= 0, `${location}@${entry.version} is below ${minimum.join('.')}`);
    }
  });
}
