import assert from 'node:assert/strict';
import test from 'node:test';

import viteConfig, { THORNODE_ARCHIVE } from '../vite.config.js';

test('the development archive proxy targets the configured archive provider', () => {
  assert.equal(THORNODE_ARCHIVE, 'https://thornode-archive.ninerealms.com');
  assert.equal(viteConfig.server.proxy['/__thornode_archive'].target, THORNODE_ARCHIVE);
});
