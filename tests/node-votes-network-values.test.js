import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildNetworkValueRows,
  filterNetworkValueRows
} from '../src/lib/node-votes/network-values.js';

const dashboardSource = readFileSync(
  new URL('../src/lib/NodeVotes.svelte', import.meta.url),
  'utf8'
);

test('network value rows list every Mimir first, then every constant', () => {
  const rows = buildNetworkValueRows({
    mimirs: {
      ZMIMIR: 9,
      CHURNINTERVAL: 43_200
    },
    constants: {
      int_64_values: {
        ChurnInterval: 21_600,
        AsgardSize: 20
      },
      bool_values: {
        StrictBondLiquidityRatio: true
      },
      string_values: {
        DefaultPoolStatus: 'Available'
      }
    }
  });

  assert.deepEqual(rows.map((row) => `${row.source}:${row.key}`), [
    'mimir:CHURNINTERVAL',
    'mimir:ZMIMIR',
    'constant:AsgardSize',
    'constant:ChurnInterval',
    'constant:DefaultPoolStatus',
    'constant:StrictBondLiquidityRatio'
  ]);
  assert.equal(rows[3].value, 21_600);
  assert.equal(rows[3].active_value, 43_200);
  assert.equal(rows[3].overridden, true);
  assert.equal(rows[5].type_label, 'BOOL');
});

test('network value search matches keys, values, sources, and constant types', () => {
  const rows = buildNetworkValueRows({
    mimirs: { MAXRUNESUPPLY: 500_000_000 },
    constants: { bool_values: { EnableDerivedAssets: true } }
  });

  assert.deepEqual(
    filterNetworkValueRows(rows, '500000000').map((row) => row.key),
    ['MAXRUNESUPPLY']
  );
  assert.deepEqual(
    filterNetworkValueRows(rows, 'bool').map((row) => row.key),
    ['EnableDerivedAssets']
  );
});

test('Vote Tracker exposes Mimirs & Constants as its third tab', () => {
  assert.match(dashboardSource, /activeTab === 'network'/);
  assert.match(dashboardSource, />Mimirs &amp; Constants<\/button>/);
  assert.match(dashboardSource, /Current Mimirs &amp; Constants/);
  assert.match(dashboardSource, /networkValueRows/);
});
