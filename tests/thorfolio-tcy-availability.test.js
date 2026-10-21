import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isThorAddress } from '../src/lib/position-tracker/addresses.js';
import { buildTcyRows, buildTcyClaimRows, summarize, summarizeByAddress, weightedTcyPayoutApr } from '../src/lib/position-tracker/model.js';

const A = 'thor12a6ggkqsmxdlwgqr9tfev2u32jc8x9pn4530hc';
const B = 'thor1lhufh0mwasa0lk9udppdegmvnkgqt08f0m9p5g';
const market = { runePriceUsd: 2, tcyPriceUsd: 1 };
const history = { distributions: [{ date: String(Math.floor(Date.now() / 1000) - 86400), amount: '100000000', price: '200000000' }] };
const dataSource = readFileSync(new URL('../src/lib/position-tracker/data.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');

function loader({ fetch, getBalance = async () => ({ balances: [] }), distributions = history }) {
  return runInNewContext(`${dataSource}\n({ loadTcy })`, {
    isThorAddress, buildTcyRows, buildTcyClaimRows,
    thornode: { fetch, getBalance },
    midgard: { getTCYDistribution: async () => distributions }
  });
}

test('failed TCY stake lookup remains unavailable, retains payouts and recovers on a later refresh', async () => {
  let failing = true;
  const client = loader({ fetch: async () => {
    if (failing) throw new Error('request timed out');
    return { amount: '10000000000' };
  } });
  const failed = await client.loadTcy([A], market);
  assert.equal(failed.rows[0].staked, null, 'a request failure must not appear as a zero stake');
  assert.equal(failed.rows[0].stakedUsd, null);
  assert.equal(failed.rows[0].stakeKnown, false);
  assert.equal(failed.rows[0].liquid, 0, 'successful empty bank lookup is still known zero');
  assert.equal(failed.rows[0].totalPayoutRune, 1);
  assert.equal(failed.rows[0].apr, null);
  assert.ok(failed.errors.some((message) => /TCY stake.*unavailable/i.test(message)));
  assert.equal(summarize({ tcyRows: failed.rows }).tcyBalanceMissing, 1);
  assert.equal(summarizeByAddress({ addresses: [A], tcyRows: failed.rows })[0].tcyBalanceMissing, 1);
  failing = false;
  const recovered = await client.loadTcy([A], market);
  assert.equal(recovered.errors.length, 0);
  assert.equal(recovered.rows[0].staked, 100);
  assert.equal(recovered.rows[0].stakeKnown, true);
  assert.equal(summarize({ tcyRows: recovered.rows }).tcyBalanceMissing, 0);
});

test('unavailable TCY stake stays visible even without historical payouts', async () => {
  const result = await loader({ fetch: async () => { throw new Error('HTTP 502'); }, distributions: { distributions: [] } }).loadTcy([A], market);
  assert.equal(result.rows.length, 1, 'unknown stake must not disappear as an empty position');
  assert.equal(result.rows[0].staked, null);
});

test('known absent staker is zero, while transport errors and malformed responses are unavailable', async () => {
  const missing = await loader({ fetch: async () => { throw new Error(`fail to tcy staker: TCYStaker doesn't exist: ${A}`); } }).loadTcy([A], market);
  assert.equal(missing.rows[0].staked, 0);
  assert.equal(missing.rows[0].stakeKnown, true);
  assert.equal(missing.errors.length, 0);
  const wrappedMissing = await loader({ fetch: async () => {
    throw new Error('All THORNode providers failed', { cause: Object.assign(new Error('HTTP 404 Not Found'), {
      body: JSON.stringify({ message: `fail to tcy staker: TCYStaker doesn't exist: ${A}` })
    }) });
  } }).loadTcy([A], market);
  assert.equal(wrappedMissing.rows[0].staked, 0);
  assert.equal(wrappedMissing.rows[0].stakeKnown, true);
  assert.equal(wrappedMissing.errors.length, 0);
  for (const payload of [null, {}, { amount: 'bad' }, { amount: '-1' }]) {
    const result = await loader({ fetch: async () => payload }).loadTcy([A], market);
    assert.equal(result.rows[0].staked, null, JSON.stringify(payload));
    assert.ok(result.errors.length > 0);
  }
  const transport = await loader({ fetch: async () => { throw Object.assign(new Error('404 Not Found'), { status: 404 }); } }).loadTcy([A], market);
  assert.equal(transport.rows[0].staked, null, 'generic HTTP 404 does not prove the stake is absent');
});

test('failed bank lookup leaves liquid TCY unavailable without discarding the known stake', async () => {
  const result = await loader({ fetch: async () => ({ amount: '10000000000' }), getBalance: async () => { throw new Error('timeout'); } }).loadTcy([A], market);
  assert.equal(result.rows[0].staked, 100);
  assert.equal(result.rows[0].liquid, null);
  assert.equal(result.rows[0].liquidUsd, null);
  assert.equal(result.rows[0].liquidKnown, false);
  const partial = summarize({ tcyRows: result.rows });
  assert.equal(partial.tcyBalanceMissing, 1);
  assert.equal(partial.tcyUsd, 100, 'partial totals retain the stake value that is known');
  assert.equal(partial.totalUsd, 100);
});

test('combined APR cannot silently omit a position whose stake is unavailable', () => {
  const rows = buildTcyRows({ addresses: [A, B], stakers: { [A]: { amount: '10000000000' }, [B]: null }, balances: { [A]: '0', [B]: '0' }, distributions: { [A]: history, [B]: history }, ...market });
  assert.equal(weightedTcyPayoutApr(rows), null);
  assert.equal(summarize({ tcyRows: rows }).tcyBalanceMissing, 1);
});

test('a confirmed zero stake and empty wallet are an empty position rather than a degraded lookup', async () => {
  const result = await loader({ fetch: async () => ({ amount: '0' }), distributions: { distributions: [] } }).loadTcy([A], market);
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(summarize({ tcyRows: result.rows }).tcyBalanceMissing, 0);
});
