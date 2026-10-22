import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createFinancialDaySource } from '../src/shared/financials-day-source.js';

// Opt in only with an explicitly named disposable database, never DATABASE_URL.
const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const day = '2026-10-22';
const from = Date.parse(`${day}T00:00:00Z`) / 1000;
const iso = seconds => new Date(seconds * 1000).toISOString();
const route = (asset, count = 144) => `/history/swaps?interval=5min&from=${from}&count=${count}&pool=${asset}`;
const dailyRoute = asset => `/history/swaps?interval=day&from=${from}&count=1&pool=${asset}`;
const migrations = ['051_pool_analysis.sql', '059_pool_analysis_depth.sql',
  '060_pool_analysis_completion.sql', '066_pool_analysis_intraday_snapshots.sql'];

test('PostgreSQL serves exact Financials prefixes without repeated provider acquisition',
  { skip: !databaseUrl }, async t => {
    assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
    const schema = `financials_source_test_${randomBytes(8).toString('hex')}`;
    const quotedSchema = `"${schema}"`;
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    let connected = false;
    try {
      await client.connect();
      connected = true;
      await client.query('begin');
      await client.query(`create schema ${quotedSchema}`);
      await client.query(`set local search_path to ${quotedSchema}`);
      await client.query("set local timezone to 'Pacific/Honolulu'");
      for (const filename of migrations) {
        const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8');
        // Keep every migration inside this test's rollback transaction. Rewrite
        // only its in-memory public qualification, never production SQL files.
        assert.match(sql, /^begin;[\s\S]*commit;\s*$/i);
        const body = sql.replace(/^begin;\s*/i, '').replace(/commit;\s*$/i, '')
          .replaceAll('public.', `${quotedSchema}.`);
        await client.query(body);
      }

      const pools = Array.from({ length: 44 }, (_, index) => ({
        asset: index === 0 ? 'BTC.BTC' : index === 1 ? 'ETH.ETH' : `TEST.POOL${index}`,
        bucket_end: iso(from + 12 * 3600),
        volume_rune_e8: (9007199254740993123456n + BigInt(index)).toString(),
        volume_usd_e2: (9007199254740995n + BigInt(index)).toString(),
        observed_at: iso(from + 12 * 3600 + 60)
      }));
      const firstQuarter = { ...pools[0], bucket_end: iso(from + 900), observed_at: iso(from + 960) };
      const midnightZeros = pools.slice(0, 2).map(pool => ({ ...pool, bucket_end: iso(from + 86400),
        volume_rune_e8: '0', volume_usd_e2: '0', observed_at: iso(from + 86460) }));
      await client.query(`insert into pool_analysis_intraday_snapshots
        (asset, bucket_end, volume_rune_e8, volume_usd_e2, fees_rune_e8, observed_at)
        select asset, bucket_end, volume_rune_e8, volume_usd_e2, 0, observed_at
        from jsonb_to_recordset($1::jsonb) as incoming(asset text, bucket_end timestamptz,
          volume_rune_e8 numeric(78, 0), volume_usd_e2 numeric(78, 0), observed_at timestamptz)`,
      [JSON.stringify([...pools, firstQuarter, ...midnightZeros])]);
      await client.query(`insert into pool_analysis_daily
        (asset, day, volume_rune_e8, volume_usd_e2, interval_start, interval_end, partial, source, completed_at)
        values ('BTC.BTC', $1::date, $2, $3, $4, $5, false, 'liquify-midgard-swaps', $6)`,
      [day, pools[0].volume_rune_e8, pools[0].volume_usd_e2, iso(from), iso(from + 86400), iso(from + 86460)]);

      await t.test('numeric strings and UTC cutoffs remain exact in a non-UTC SQL session', async () => {
        const { rows: [stored] } = await client.query(`select volume_rune_e8, volume_usd_e2, bucket_end,
          bucket_end::text as local_end, pg_typeof(volume_rune_e8)::text as amount_type
          from pool_analysis_intraday_snapshots where asset = $1 and bucket_end = $2`,
        [firstQuarter.asset, firstQuarter.bucket_end]);
        assert.equal(stored.amount_type, 'numeric');
        assert.equal(typeof stored.volume_rune_e8, 'string');
        assert.equal(typeof stored.volume_usd_e2, 'string');
        assert.equal(stored.bucket_end.toISOString(), firstQuarter.bucket_end);
        assert.match(stored.local_end, /^2026-10-21 14:15:00-10$/,
          'the session calendar day differs from the requested UTC day');
        const get = createFinancialDaySource({ client,
          getJson: () => assert.fail('the exact prefix must not call the provider') });
        assert.deepEqual((await get(route('BTC.BTC', 3))).intervals, [{
          startTime: String(from), endTime: String(from + 900),
          totalVolume: firstQuarter.volume_rune_e8, totalVolumeUSD: firstQuarter.volume_usd_e2
        }]);
      });

      await t.test('44 saved pool prefixes cost zero provider requests, and one missing pool costs only one', async () => {
        const requests = [];
        const get = createFinancialDaySource({ client, getJson: async request => {
          requests.push(request);
          return { upstream: request };
        } });
        const result = [];
        for (const pool of pools) result.push(await get(route(pool.asset)));
        assert.equal(result.length, 44);
        result.forEach((payload, index) => {
          assert.deepEqual(payload.intervals, [{ startTime: String(from), endTime: String(from + 12 * 3600),
            totalVolume: pools[index].volume_rune_e8, totalVolumeUSD: pools[index].volume_usd_e2 }]);
          assert.equal(typeof payload.intervals[0].totalVolume, 'string');
          assert.equal(typeof payload.intervals[0].totalVolumeUSD, 'string');
        });
        assert.deepEqual(requests, []);
        const missing = route('TEST.MISSING');
        assert.deepEqual(await get(missing), { upstream: missing });
        assert.deepEqual(requests, [missing]);
      });

      await t.test('next-midnight zero prefixes cannot masquerade as the prior completed day', async () => {
        const requests = [];
        const get = createFinancialDaySource({ client, getJson: async request => {
          requests.push(request);
          return { upstream: request };
        } });
        const fullDayAsPrefix = route('BTC.BTC', 288);
        assert.deepEqual(await get(fullDayAsPrefix), { upstream: fullDayAsPrefix });
        assert.deepEqual((await get(dailyRoute('BTC.BTC'))).intervals, [{
          startTime: String(from), endTime: String(from + 86400),
          totalVolume: pools[0].volume_rune_e8, totalVolumeUSD: pools[0].volume_usd_e2
        }]);
        const missingDay = dailyRoute('ETH.ETH');
        assert.deepEqual(await get(missingDay), { upstream: missingDay });
        assert.deepEqual(requests, [fullDayAsPrefix, missingDay]);
      });
    } finally {
      try {
        // Schema, migrations and observations are all transactional. No public
        // objects are touched, even when a test assertion or migration fails.
        if (connected) {
          await client.query('rollback');
          const { rows: [result] } = await client.query('select to_regnamespace($1) as remaining', [schema]);
          assert.equal(result.remaining, null);
        }
      } finally { await client.end(); }
    }
  });
