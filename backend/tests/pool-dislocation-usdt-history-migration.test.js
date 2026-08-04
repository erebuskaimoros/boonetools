import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const MIGRATION_NAME = '042_pool_dislocation_binance_usdt_to_usd.sql';

test('historical Binance USDT quotes are converted with one valid same-bucket Oracle rate', async () => {
  const migration = await readFile(
    new URL(`../migrations/${MIGRATION_NAME}`, import.meta.url),
    'utf8'
  );

  assert.match(migration, /upper\s*\(\s*binance_symbol\s*\)\s+like\s+'%USDT'/i);
  assert.match(migration, /usdt_rate_buckets\s+as\s+materialized/i);
  assert.match(migration, /oracle_symbol\s*=\s*'USDT'/i);
  assert.match(migration, /oracle_price_usd\s*>\s*0/i);
  assert.match(migration, /group by\s+observed_at/i);
  assert.match(migration, /having\s+count\s*\(\s*distinct\s+oracle_price_usd\s*\)\s*=\s*1/i);
  assert.match(migration, /count\s*\(\s*distinct\s+oracle_observed_at\s*\)\s*=\s*1/i);
  assert.match(migration, /rate\.thorchain_height\s+is not distinct from\s+archive\.thorchain_height/i);
  assert.match(migration, /rate\.sample_origin\s*=\s*archive\.sample_origin/i);
  assert.match(migration, /extract\s*\(\s*epoch from\s*\(\s*rate\.oracle_observed_at\s*-\s*archive\.binance_observed_at/i);
  assert.match(migration, /<=\s*30/i);
  assert.match(migration, /rate\.observed_at\s*=\s*archive\.observed_at/i);
  assert.match(migration, /binance_bid_usdt\s*\*\s*repair\.usdt_usd_rate/i);
  assert.match(migration, /binance_ask_usdt\s*\*\s*repair\.usdt_usd_rate/i);
  assert.match(migration, /binance_price_usdt\s*\*\s*repair\.usdt_usd_rate/i);
  assert.match(migration, /book-ticker-mid-usdt-to-usd/i);
  assert.match(migration, /kline-close-usdt-to-usd/i);
  assert.match(migration, /usdt-to-usd-unaligned/i);
});

test('historical correction preserves raw quotes, fails closed, and invalidates the summary', async () => {
  const migration = await readFile(
    new URL(`../migrations/${MIGRATION_NAME}`, import.meta.url),
    'utf8'
  );

  assert.match(migration, /create table if not exists public\.pool_dislocation_binance_usdt_archive/i);
  assert.match(migration, /primary key\s*\(\s*observed_at\s*,\s*asset\s*\)/i);
  assert.match(migration, /on conflict\s*\(\s*observed_at\s*,\s*asset\s*\)\s*do nothing/i);
  assert.match(migration, /usdt_usd_rate\s+numeric/i);
  assert.match(migration, /usdt_oracle_observed_at\s+timestamptz/i);
  assert.match(migration, /conversion_status\s+text/i);
  assert.match(migration, /set usdt_usd_rate\s*=\s*repair\.usdt_usd_rate/i);
  assert.match(migration, /when repair\.usdt_usd_rate is null then null/i);
  assert.match(migration, /binance_observed_at\s*=\s*repair\.binance_observed_at/i);
  assert.match(migration, /source_skew_ms\s*=\s*repair\.source_skew_ms/i);
  assert.match(migration, /usdt-to-usd-unavailable/i);
  assert.match(migration, /delete from public\.api_read_models/i);
  assert.match(migration, /model_key\s*=\s*'pool-dislocation-summary:v1'/i);
});

test('the USDT history correction is the next migration after the production baseline', async () => {
  const migrationNames = (await readdir(new URL('../migrations/', import.meta.url)))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const baselineIndex = migrationNames.indexOf('041_dedicated_provider_cooldown_scope.sql');

  assert.ok(baselineIndex >= 0);
  assert.equal(migrationNames[baselineIndex + 1], MIGRATION_NAME);
});
