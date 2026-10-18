import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';

for (const collector of ['rewards', 'base-fees', 'reserve-payments']) {
  for (const failFirst of [false, true]) {
    test(`${collector}: concurrent fetches, serial persistence, and peer progress (${failFirst ? 'failure' : 'success'})`, async () => {
      const rows = [28290001, 28290002, 28290003].map(height => ({ height,
        block_time: '2026-10-18T01:00:00Z', attempts: 0 }));
      const calls = [], gates = [], saved = [];
      let queries = 0, peakQueries = 0;
      const client = { query: async (sql, params = []) => {
        peakQueries = Math.max(peakQueries, ++queries);
        await tick();
        queries--;
        if (sql.includes('order by blocks.height') || sql.includes('select height, block_time')) return { rows };
        if (sql.includes("'fetched'") || params.includes('fetched')) saved.push(Number(params[0]));
        return { rows: [], rowCount: 0 };
      } };
      const fetchOne = async height => {
        calls.push(height);
        await new Promise(resolve => gates.push(resolve));
        if (failFirst && height === rows[0].height) throw Object.assign(new Error('HTTP 429 unavailable'), { status: 429 });
        return { id: String(height), result: { height: String(height), txs_results: [], finalize_block_events: [] } };
      };
      const options = { limit: 3, batchSize: 1, batchConcurrency: 2, requestSpacingMs: 0, requestDelayMs: 0 };
      let run;
      if (collector === 'rewards') {
        const { repairFinancialRewardBlocks } = await import('../src/shared/financials-reward-source.js');
        run = () => repairFinancialRewardBlocks(client, { ...options,
          fetchBatch: async ([height]) => [await fetchOne(height)],
          save: async (_client, observations) => {
            peakQueries = Math.max(peakQueries, ++queries);
            await tick(); queries--;
            saved.push(...observations.map(row => row.height));
          } });
      } else if (collector === 'base-fees') {
        const { processRujiraBaseFeeBlocks } = await import('../src/shared/rujira-base-fees.js');
        run = () => processRujiraBaseFeeBlocks(client, { ...options,
          fetchBatch: async ([height]) => [{ height, payload: await fetchOne(height) }] });
      } else {
        const { processRujiraReservePaymentBlocks } = await import('../src/shared/rujira-reserve-payments.js');
        run = () => processRujiraReservePaymentBlocks(client, { ...options, fetchBlockResults: fetchOne });
      }
      const pending = failFirst ? assert.rejects(run(), /429/) : run();
      for (let i = 0; i < 20 && calls.length < 2; i++) await tick();
      assert.deepEqual(calls, rows.slice(0, 2).map(row => row.height));
      gates[0](); await tick();
      assert.deepEqual(saved, [], 'no persistence while the peer is still running');
      gates[1]();
      if (!failFirst) {
        for (let i = 0; i < 40 && calls.length < 3; i++) await tick();
        assert.equal(calls.length, 3);
        gates[2]();
      }
      await pending;
      assert.deepEqual(saved, (failFirst ? rows.slice(1, 2) : rows).map(row => row.height));
      assert.equal(peakQueries, 1, 'SQL operations must never overlap');
      assert.equal(calls.length, failFirst ? 2 : 3);
    });
  }
}
