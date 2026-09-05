import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPoolAnalysisSnapshot } from '../src/shared/pool-analysis-rolling.js';

test('quarter-hour collection needs only one current-day request per pool', async () => {
  let requests = 0;
  const cutoff = Date.parse('2026-09-05T12:15:00Z') / 1000;
  await fetchPoolAnalysisSnapshot('BTC.BTC', cutoff, {
    fetchMidgard: async (route) => {
      requests++;
      const query = new URL(route, 'https://test.invalid').searchParams;
      return { intervals: [], meta: { startTime: query.get('from'), endTime: query.get('to'),
        totalVolume: '123', totalVolumeUSD: '456', totalFees: '7', runePriceUSD: '1' } };
    }
  });
  assert.equal(requests, 1, 'Persist the existing current-day sample; do not fetch old boundaries');
});
