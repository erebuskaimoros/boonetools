import assert from 'node:assert/strict';
import test from 'node:test';
import { comparisonSeedSql, prepareComparisonSeed } from '../scripts/seed-protocol-fee-comparison.mjs';

const saved = () => ({ cache: { version: 1, boundaries: { '2026-09-01': { height: 1 } }, nearEpochs: { epoch: { minted: '10' } }, days: {
  '2026-09-01': { earnings: { runePriceUSD: 1, liquidityFees: 200000000, blockRewards: 100000000 },
    nearRevenue: 3, nearPrice: 1, nearIssuance: 1, wallets: { frontend_near: 0, other_near: 1, source: 'fastnear' },
    chainflipRevenue: 4, flipPrice: 1, flipIssuance: { atomic: '1000000000000000000' } }
} }, payload: { asOf: '2026-09-02T12:00:00Z', errors: ['Historical archive unavailable'] } });

test('seed preserves observations, checkpoints, original freshness, and historical gaps', () => {
  const input = saved();
  const seed = prepareComparisonSeed(input);
  assert.deepEqual(seed.cache, input.cache);
  assert.equal(seed.payload.asOf, '2026-09-02T12:00:00.000Z');
  assert.equal(seed.payload.months.length, 13);
  assert.equal(seed.payload.months[0].protocols.chainflip.netUsd, null);
  assert.equal(seed.payload.months.at(-1).protocols.chainflip.netUsd, 3);
  assert.equal(seed.payload.stale, true);
  assert.deepEqual(seed.payload.errors, input.payload.errors);
  assert.equal(seed.summary.nearEpochs, 1);
  assert.equal(seed.summary.flipDays, 1);
});

test('seed refuses malformed, empty and future snapshots', () => {
  assert.throws(() => prepareComparisonSeed({}), /version-1/);
  const empty = saved(); empty.cache.days = {};
  assert.throws(() => prepareComparisonSeed(empty), /no aligned/);
  assert.throws(() => prepareComparisonSeed(saved(), { now: 0 }), /future/);
});

test('SQL is atomic, takes the collector lock, refuses overwrites, and encodes input text', () => {
  const input = saved();
  input.payload.errors = ["'); DROP TABLE api_read_models; --\n\\quit"];
  const sql = comparisonSeedSql(prepareComparisonSeed(input));
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /pg_try_advisory_xact_lock\(hashtext\('boonetools:protocol-fee-comparison'\)\)/);
  assert.match(sql, /bootstrap refuses to overwrite production/);
  assert.match(sql, /INSERT INTO source_observations/);
  assert.match(sql, /INSERT INTO api_read_models/);
  assert.doesNotMatch(sql, /DROP TABLE|\\quit|ON CONFLICT|DELETE FROM/);
  assert.match(sql, /COMMIT;\n$/);
});
