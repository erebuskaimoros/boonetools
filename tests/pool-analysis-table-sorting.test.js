import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePoolAnalysisSummary, sortPoolAnalysisRows } from '../src/lib/pool-analysis/model.js';

test('pool balance sorting uses numeric RUNE amounts, retains precision and leaves missing values last', () => {
  const rows = normalizePoolAnalysisSummary({ pools: [
    { asset: 'SMALL.SMALL', balance_rune_e8: '900000000' },
    { asset: 'LARGE.LARGE', balance_rune_e8: '1000000000' },
    { asset: 'Z.Z', balance_rune_e8: '9007199254740992' },
    { asset: 'A.A', balance_rune_e8: '9007199254740993' },
    { asset: 'MISSING.MISSING', balance_rune_e8: null },
    { asset: 'ZERO.ZERO', balance_rune_e8: '0' }
  ] }).pools;
  const ascending = ['ZERO.ZERO', 'SMALL.SMALL', 'LARGE.LARGE', 'Z.Z', 'A.A'];
  for (const direction of ['asc', 'desc']) {
    assert.deepEqual(sortPoolAnalysisRows(rows, { column: 'balanceRuneBase', direction }).map(row => row.asset),
      [...(direction === 'asc' ? ascending : [...ascending].reverse()), 'MISSING.MISSING']);
  }
});

test('equal balances retain deterministic asset order regardless of sort direction', () => {
  const rows = [
    { asset: 'Z.Z', balanceRuneBase: '0100' },
    { asset: 'A.A', balanceRuneBase: '100' },
    { asset: 'M.M', balanceRuneBase: null }
  ];
  for (const direction of ['asc', 'desc']) {
    assert.deepEqual(sortPoolAnalysisRows(rows, { column: 'balanceRuneBase', direction }).map(row => row.asset),
      ['A.A', 'Z.Z', 'M.M']);
  }
});

test('a newly tracked pool with no completed days preserves zero expected coverage', () => {
  const row = normalizePoolAnalysisSummary({ pools: [{
    asset: 'NEW.NEW', period_metrics: {
      '30d': { coverage: { observed_days: 0, expected_days: 0, missing_days: 0 } }
    }
  }] }).pools[0];
  assert.deepEqual(row.coverage, {
    firstDay: '', lastDay: '', observedDays: 0, expectedDays: 0, missingDays: 0
  });
});
