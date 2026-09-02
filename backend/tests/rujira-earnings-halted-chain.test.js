import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';
process.env.PROVIDER_COOLDOWN_ENABLED = 'false';
process.env.NODE_VOTES_REQUEST_DELAY_MS = '0';
process.env.RPC_REST_URLS = 'https://rpc.example';
process.env.RPC_ARCHIVE_REST_URL = 'https://rpc.example';
process.env.THORNODE_URLS = 'https://thornode.example';
process.env.THORNODE_ARCHIVE_URL = 'https://thornode.example';

const { pool } = await import('../src/db/pool.js');
const { refreshRujiraBaseLayerEarnings } = await import('../src/shared/rujira-base-layer-earnings.js');

function earningsFixture(t, options = {}) {
  const targetMs = Date.parse('2026-09-02T00:00:00Z');
  const headHeight = 27656320;
  const earliestHeight = 27584001;
  const headTime = Date.parse('2026-09-02T04:34:49.737Z');
  const blockTime = options.blockTime || ((height) => new Date(headTime - (headHeight - height) * 6100).toISOString());
  let baseline = null;
  let storedDay = null;
  const requestedHeights = [];
  const historicalHeights = [];
  const client = {
    async query(sql, params = []) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [] };
      if (sql.includes('settlement_by_day')) return { rows: [] };
      if (sql.includes('chain_block_headers')) return { rows: options.headers || [] };
      if (sql.includes('order by abs(extract(epoch')) {
        return { rows: [{ height: 27580136, block_time: '2026-08-26T00:04:06Z' }] };
      }
      if (sql.includes('insert into rujira_base_layer_earnings_day_baselines')) {
        baseline = { day_start: params[0], snapshot_height: params[1], snapshot_time: params[2], collector_balances: params[3] };
        return { rows: [] };
      }
      if (sql.includes('from rujira_base_layer_earnings_day_baselines')) {
        return { rows: baseline ? [baseline] : [] };
      }
      if (sql.includes('coalesce(sum(amount_rune)')) return { rows: [{ amount_rune: 0, amount_usd: 0 }] };
      if (sql.includes('insert into rujira_base_layer_earnings_daily')) {
        storedDay = params;
        return { rows: [] };
      }
      throw new Error(`Unexpected test query: ${sql}`);
    },
    release() {}
  };
  t.mock.method(pool, 'connect', async () => client);
  t.mock.method(globalThis, 'fetch', async (input, fetchOptions = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/status')) {
      assert.ok(!options.forbidRpc, 'stored adjacent midnight headers should avoid RPC lookup');
      return Response.json({ result: { sync_info: {
        earliest_block_height: String(earliestHeight),
        earliest_block_time: blockTime(earliestHeight),
        latest_block_height: String(headHeight),
        latest_block_time: blockTime(headHeight),
        ...options.syncInfo
      } } });
    }
    if (url.pathname.endsWith('/lastblock')) return Response.json([{ thorchain: headHeight }]);
    if (url.pathname.endsWith('/block')) {
      const height = Number(url.searchParams.get('height'));
      requestedHeights.push(height);
      if (height > headHeight || height < earliestHeight) {
        return Response.json({ error: { code: -32603, message: 'Internal error', data: `height ${height} must be less than or equal to the current blockchain height ${headHeight}` } });
      }
      return Response.json({ result: { block: { header: {
        height: String(height),
        time: options.rpcBlockTime ? options.rpcBlockTime(height) : blockTime(height)
      } } } });
    }
    if (url.pathname.includes('/balances/')) {
      const height = Number(new Headers(fetchOptions.headers).get('x-cosmos-block-height'));
      historicalHeights.push(height);
      if (height > headHeight || height < earliestHeight) {
        return Response.json({ message: 'requested historical height is unavailable' }, { status: 400 });
      }
      return Response.json({ balances: [{ denom: 'rune', amount: '100000000' }] });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  });

  const base = 'thor1txum04wp8ykqudphxy9prtwsd9jpcm2kwdaxctxeeyr6g0r0we9qpfdktr';
  const keys = ['trade', 'core', 'base'];
  const payload = {
    fetched_at: '2026-09-02T04:31:54Z',
    network: { rune_price_in_tor: '50000000' },
    pools: [],
    configs: Object.fromEntries(keys.map((key) => [key, {
      target_addresses: key === 'base' ? [['thor1reserve', 1]] : [[base, 1], ['thor1stakers', 1]],
      target_denoms: [['rune', '1']]
    }])),
    actions: Object.fromEntries(keys.map((key) => [key, []])),
    collector_balances: Object.fromEntries(keys.map((key) => [key, [{ denom: 'rune', amount: '300000000' }]]))
  };

  return {
    refresh: () => refreshRujiraBaseLayerEarnings(payload),
    get baseline() { return baseline; },
    get storedDay() { return storedDay; },
    requestedHeights,
    historicalHeights,
    blockTime,
    earliestHeight,
    headHeight,
    targetMs
  };
}

test('earnings resume when the last payout projects midnight beyond the current chain head', async (t) => {
  const fixture = earningsFixture(t);
  await fixture.refresh();
  const { storedDay, historicalHeights, requestedHeights, earliestHeight, headHeight, blockTime, baseline, targetMs } = fixture;
  assert.equal(storedDay?.[0], '2026-09-02', 'the daily earnings row must be published');
  assert.equal(historicalHeights.length, 3);
  assert.ok(requestedHeights.every((height) => height >= earliestHeight && height <= headHeight), 'never request an unproduced or unavailable block');
  assert.ok(Math.abs(Date.parse(blockTime(baseline.snapshot_height)) - targetMs) <= 12_000, 'resolve the midnight baseline using actual chain times');
  assert.equal(storedDay[11], 2, 'only the fresh weighted inventory increase is earnings');
});

test('adjacent stored midnight headers avoid RPC and preserve the actual baseline timestamp', async (t) => {
  const snapshot = { height: 27652000, block_time: '2026-09-01T23:59:58.500Z' };
  const fixture = earningsFixture(t, { headers: [snapshot], forbidRpc: true });

  await fixture.refresh();

  assert.deepEqual(fixture.historicalHeights, [snapshot.height, snapshot.height, snapshot.height]);
  assert.equal(fixture.baseline.snapshot_time, snapshot.block_time);
  assert.equal(fixture.storedDay[11], 2);
});

test('a halt across midnight keeps the pre-halt inventory as baseline after blocks resume', async (t) => {
  const lastBeforeMidnight = 27655000;
  const beforeTime = Date.parse('2026-09-01T23:55:00Z');
  const resumedTime = Date.parse('2026-09-02T02:00:00Z');
  const blockTime = (height) => new Date(height <= lastBeforeMidnight
    ? beforeTime - (lastBeforeMidnight - height) * 25_000
    : resumedTime + (height - lastBeforeMidnight - 1) * 9000).toISOString();
  const fixture = earningsFixture(t, { blockTime });

  await fixture.refresh();

  assert.equal(fixture.baseline.snapshot_height, lastBeforeMidnight);
  assert.equal(fixture.baseline.snapshot_time, blockTime(lastBeforeMidnight));
  assert.equal(fixture.storedDay[11], 2);
  assert.ok(fixture.requestedHeights.every((height) => height >= fixture.earliestHeight && height <= fixture.headHeight));
});

test('missing RPC status timestamps are recovered from actual boundary blocks', async (t) => {
  const fixture = earningsFixture(t, { syncInfo: { earliest_block_time: null, latest_block_time: 'invalid' } });

  await fixture.refresh();

  assert.ok(fixture.requestedHeights.includes(fixture.earliestHeight));
  assert.ok(fixture.requestedHeights.includes(fixture.headHeight));
  assert.ok(Date.parse(fixture.baseline.snapshot_time) < fixture.targetMs);
  assert.equal(fixture.storedDay[11], 2);
});

test('missing RPC block timestamps cannot publish an estimated or latest-balance baseline', async (t) => {
  const fixture = earningsFixture(t, { rpcBlockTime: () => null });

  await assert.rejects(fixture.refresh(), /Unable to read Base Layer earnings block time/);

  assert.deepEqual(fixture.historicalHeights, []);
  assert.equal(fixture.baseline, null);
  assert.equal(fixture.storedDay, null);
});

test('pruned midnight history cannot substitute the earliest available balance', async (t) => {
  const fixture = earningsFixture(t, { syncInfo: { earliest_block_time: '2026-09-02T01:00:00Z' } });

  await assert.rejects(fixture.refresh(), /do not bracket Base Layer earnings midnight/);

  assert.deepEqual(fixture.historicalHeights, []);
  assert.equal(fixture.baseline, null);
  assert.equal(fixture.storedDay, null);
});
