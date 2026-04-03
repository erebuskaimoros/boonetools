import test from 'node:test';
import assert from 'node:assert/strict';

import { mergePendingCandidateBatches } from '../src/shared/rapid-swap-candidates.js';

function buildCandidate(hintKey) {
  return { hint_key: hintKey };
}

test('mergePendingCandidateBatches prioritizes fresh rows, keeps aged rows, and de-dupes overlaps', () => {
  const freshRows = [
    buildCandidate('fresh-3'),
    buildCandidate('fresh-2'),
    buildCandidate('shared')
  ];
  const agedRows = [
    buildCandidate('aged-1'),
    buildCandidate('shared'),
    buildCandidate('aged-2')
  ];
  const fillerRows = [
    buildCandidate('fill-1'),
    buildCandidate('aged-1')
  ];

  const result = mergePendingCandidateBatches([freshRows, agedRows, fillerRows], 5);

  assert.deepEqual(
    result.map((row) => row.hint_key),
    ['fresh-3', 'fresh-2', 'shared', 'aged-1', 'aged-2']
  );
});

test('mergePendingCandidateBatches respects the requested limit', () => {
  const result = mergePendingCandidateBatches([
    [buildCandidate('fresh-1'), buildCandidate('fresh-2')],
    [buildCandidate('aged-1')]
  ], 2);

  assert.deepEqual(
    result.map((row) => row.hint_key),
    ['fresh-1', 'fresh-2']
  );
});
