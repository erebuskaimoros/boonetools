import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import {
  advanceStableSwapBackfill,
  buildStableSwapAssetFilter,
  stableSwapBackfillRecord,
  stableSwapBackfillWindow,
  stableSwapFilterGroups
} from '../src/shared/dynamic-fee-stable-swap-backfill.js';
import { isStableSwapRoute } from '../../shared/dynamic-fees/stable-swaps.js';

const databaseUrl = process.env.ACQUISITION_TEST_DATABASE_URL;
const postgres = { skip: !databaseUrl };
const nowMs = Date.parse('2026-11-13T15:00:00Z');
const BASE = 'https://midgard.test/v2';
const USDC = 'ETH.USDC-0XA0B8';
const USDT = 'ETH.USDT-0XDAC1';
const TRADE_USDT = 'ETH~USDT-0XDAC1';
const SECURED_USDT = 'ETH-USDT-0XDAC1';
const POOLS = [
  { asset: USDC, volume24h: '500' },
  { asset: USDT, volume24h: '900' },
  { asset: 'BTC.BTC', volume24h: '99999' },
  { asset: 'ETH~USDC-0XA0B8', volume24h: '1' }
];
const seconds = (iso) => Date.parse(iso) / 1000;

let txCount = 0;
function action({ at, from, to, amount = '100000000000', status = 'success', fee = '100000000',
  affiliate = false, refund = false, outCoin, txId }) {
  txCount += 1;
  const ns = BigInt(Math.round(Date.parse(at))) * 1_000_000n;
  return {
    date: String(ns), height: String(1000 + txCount), status, type: 'swap',
    in: [{ txID: txId || `tx${txCount}`, coins: [{ asset: from, amount }] }],
    out: [
      ...(affiliate ? [{ affiliate: true, coins: [{ asset: 'THOR.RUNE', amount: '1000' }] }] : []),
      ...(refund ? [{ coins: [{ asset: from, amount: '5' }] }] : []),
      ...(to ? [{ coins: [{ asset: to, amount }] }] : [])
    ],
    metadata: { swap: { liquidityFee: fee, ...(outCoin ? { streamingSwapMeta: { outCoin: { asset: outCoin, amount: '0' } } } : {}) } }
  };
}

// The UTC day 2026-11-09 and its neighbours. Filter groups (see POOLS) are
// [ETH-USDC, ETH-USDT, ETH.USDC, ETH~USDC] and [ETH~USDT]; ETH.USDT is omitted.
const ACTIONS = {
  beforeDay: action({ at: '2026-11-08T23:59:59.500Z', from: USDC, to: USDT, txId: 'BEFORE' }),
  midnight: action({ at: '2026-11-09T00:00:00Z', from: USDC, to: USDT, affiliate: true, txId: 'MIDNIGHT' }),
  toBtc: action({ at: '2026-11-09T06:00:00Z', from: USDC, to: 'BTC.BTC' }),
  fromRune: action({ at: '2026-11-09T07:00:00Z', from: 'THOR.RUNE', to: TRADE_USDT }),
  pending: action({ at: '2026-11-09T08:00:00Z', from: USDC, to: USDT, status: 'pending' }),
  stream: action({ at: '2026-11-09T09:00:00Z', from: USDC, to: null, outCoin: TRADE_USDT, amount: '30000000000', fee: '50000000', txId: 'STREAM' }),
  refunded: action({ at: '2026-11-09T10:00:00Z', from: SECURED_USDT, to: USDC, refund: true, amount: '20000000000', fee: '10000000', txId: 'REFUND' }),
  cross: action({ at: '2026-11-09T11:00:00Z', from: USDC, to: TRADE_USDT, amount: '5000000000', fee: '0', txId: 'CROSS' }),
  nextDay: action({ at: '2026-11-10T00:00:00Z', from: USDC, to: USDT }),
  nextDayTrade: action({ at: '2026-11-10T01:00:00Z', from: TRADE_USDT, to: USDC })
};

/** A Midgard stand-in: OR asset filter, exclusive lower bound, ascending pages. */
function fakeMidgard({ actions = Object.values(ACTIONS), pools = POOLS, prices = { '2026-11-09': '2', '2026-11-08': '1.5' },
  pageSize = 3, failAction = () => null, failMidgard = () => null, token: tokenFor } = {}) {
  const calls = [];
  const midgardCalls = [];
  const fetchActions = async (params, options) => {
    calls.push({ params, options });
    const failure = failAction(calls.length, params);
    if (failure) throw failure;
    const assets = new Set(params.asset.split(','));
    const matching = actions
      .filter((row) => [...row.in, ...row.out].some((leg) => leg.coins.some((coin) => assets.has(coin.asset))))
      .sort((a, b) => (BigInt(a.date) < BigInt(b.date) ? -1 : 1));
    let offset = params.prevPageToken ? Number(params.prevPageToken.split('@')[1])
      : matching.findIndex((row) => BigInt(row.date) > BigInt(params.fromTimestamp) * 1_000_000_000n);
    if (offset < 0) offset = matching.length;
    const page = matching.slice(offset, offset + pageSize);
    const next = page.length ? `${params.asset}@${offset + pageSize}` : '';
    return { actions: page, meta: { prevPageToken: tokenFor ? tokenFor(next) : next } };
  };
  const fetchMidgard = async (path, options) => {
    midgardCalls.push({ path, options });
    const failure = failMidgard(midgardCalls.length, path);
    if (failure) throw failure;
    if (path === '/pools') return pools;
    const query = new URL(path, 'https://midgard.invalid').searchParams;
    const from = Number(query.get('from'));
    const day = new Date(from * 1000).toISOString().slice(0, 10);
    return { intervals: prices[day] ? [{ startTime: String(from), endTime: query.get('to'), runePriceUSD: prices[day] }] : [] };
  };
  return { calls, midgardCalls, options: { fetchActions, fetchMidgard, bases: [BASE], nowMs } };
}

test('stable swap backfill window covers the 90 UTC days before the ledger start', () => {
  assert.deepEqual(stableSwapBackfillWindow('2026-11-10'), { ledgerStart: '2026-11-10', targetStart: '2026-08-12' });
});

test('asset filter lists every stable variant except the largest stable pool, losing no stable pair', () => {
  const pools = [...POOLS, { asset: 'TRON.USDT-TR7N', volume24h: '700' }, { asset: 'BSC.BUSD-0XE9E7', volume24h: 'n/a' }];
  const { assets, omitted } = buildStableSwapAssetFilter(pools);
  assert.equal(omitted, USDT);
  assert.equal(assets.length, 4 * 3 - 1);
  assert.ok(!assets.includes(USDT));
  for (const variant of [TRADE_USDT, SECURED_USDT, 'TRON~USDT-TR7N', 'BSC-BUSD-0XE9E7', USDC]) assert.ok(assets.includes(variant), variant);
  assert.ok(!assets.some((asset) => asset.startsWith('BTC')));
  // Every route between two different stable assets lists at least one side.
  const universe = [...assets, omitted];
  for (const input of universe) for (const output of universe) {
    if (input !== output) assert.ok(assets.includes(input) || assets.includes(output), `${input} -> ${output}`);
  }
  assert.deepEqual(stableSwapFilterGroups(assets).map((group) => group.length), [4, 4, 3]);
  assert.throws(() => buildStableSwapAssetFilter([{ asset: USDC, volume24h: '1' }]), /fewer than two/);
});

test('stable swap records keep only successful stable-to-stable swaps', () => {
  assert.deepEqual(stableSwapBackfillRecord(ACTIONS.midnight), {
    action_key: 'MIDNIGHT', day: '2026-11-09', action_time: seconds('2026-11-09T00:00:00Z'), height: Number(ACTIONS.midnight.height),
    input_asset: USDC, input_e8: '100000000000', output_asset: USDT, fee_rune_e8: '100000000'
  }, 'the affiliate RUNE leg does not decide the output');
  assert.equal(stableSwapBackfillRecord(ACTIONS.stream).output_asset, TRADE_USDT, 'streaming outCoin fallback');
  assert.equal(stableSwapBackfillRecord(ACTIONS.refunded).output_asset, USDC, 'a refund leg is not the output');
  assert.equal(stableSwapBackfillRecord(ACTIONS.pending), null);
  assert.equal(stableSwapBackfillRecord(ACTIONS.toBtc), null);
  assert.equal(stableSwapBackfillRecord(ACTIONS.fromRune), null);
  const twoCoins = { ...ACTIONS.midnight, in: [{ txID: 'b', coins: [{ asset: USDC, amount: '5' }] }, { txID: 'A', coins: [{ asset: USDC, amount: '7' }] }],
    metadata: { swap: {} } };
  const record = stableSwapBackfillRecord(twoCoins);
  assert.equal(record.input_e8, '12');
  assert.equal(record.action_key, 'A:B');
  assert.equal(record.fee_rune_e8, null);
  assert.ok(isStableSwapRoute(record.input_asset, record.output_asset));
});

// Runs the step's own begin/commit/rollback as savepoints inside the test's
// outer transaction, which is rolled back with its schema afterwards.
function savepointClient(client) {
  return {
    query(text, values) {
      if (text === 'begin') return client.query('savepoint stable_swap_backfill');
      if (text === 'commit') return client.query('release savepoint stable_swap_backfill');
      if (text === 'rollback') return client.query('rollback to savepoint stable_swap_backfill');
      return client.query(text, values);
    }
  };
}

async function withDatabase(run) {
  assert.match(new URL(databaseUrl).pathname, /^\/(?:boonetools_)?acquisition_test(?:_|$)/);
  const schema = `stable_backfill_${randomBytes(8).toString('hex')}`;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    for (const migration of ['073_financials_swap_candidates.sql',
      '076_financials_fee_candidates.sql', '080_dynamic_fee_stable_swap_backfill.sql']) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
      await client.query(sql.replace(/^\s*(begin|commit);\s*$/gim, '').replaceAll('public.', ''));
    }
    await client.query("update financials_swap_ledger set fee_started_at = '2026-11-10T00:00:00Z'");
    await run(savepointClient(client));
  } finally { await client.query('rollback'); await client.end(); }
}

const swapRows = async (client) => (await client.query(`select action_key, day::text, input_asset, input_e8::text,
  output_asset, fee_rune_e8::text from dynamic_fee_stable_swap_backfill_swaps order by action_key`)).rows;
const dayRows = async (client) => (await client.query(`select day::text, rune_price_usd::text, actions_scanned::text, swaps
  from dynamic_fee_stable_swap_backfill_days order by day`)).rows;
const backfillState = async (client) => (await client.query(`select ledger_start::text, target_start::text, asset_filter,
  omitted_asset, scan_day::text, group_index, source_base, page_token, last_error, completed_at,
  available_at > now() as deferred, available_at from dynamic_fee_stable_swap_backfill`)).rows[0];
const allow = (client) => client.query('update dynamic_fee_stable_swap_backfill set available_at = now()');

test('backfill waits without provider calls while the ledger has no settled coverage start', postgres, async () => {
  await withDatabase(async (client) => {
    const midgard = fakeMidgard();
    await client.query('delete from financials_swap_ledger');
    assert.deepEqual(await advanceStableSwapBackfill(client, midgard.options),
      { status: 'waiting', pages: 0, days_completed: 0, swaps: 0 });
    await client.query("update financials_swap_ledger set fee_started_at = '2026-11-20T00:00:00Z'");
    assert.equal((await advanceStableSwapBackfill(client, midgard.options)).status, 'waiting');
    assert.equal(midgard.calls.length + midgard.midgardCalls.length, 0);
    assert.equal(await backfillState(client), undefined);
  });
});

test('a day scan pages with tokens, honours the exclusive lower bound and keeps stable routes', postgres, async () => {
  await withDatabase(async (client) => {
    const midgard = fakeMidgard();
    const result = await advanceStableSwapBackfill(client, { ...midgard.options, maxPages: 4 });
    assert.deepEqual(result, { status: 'scanning', pages: 4, days_completed: 1, swaps: 5 });

    const groups = ['ETH-USDC-0XA0B8,ETH-USDT-0XDAC1,ETH.USDC-0XA0B8,ETH~USDC-0XA0B8', TRADE_USDT];
    const dayEnd = String(seconds('2026-11-10T00:00:00Z'));
    assert.deepEqual(midgard.calls.map((call) => call.params), [
      { type: 'swap', asset: groups[0], limit: '50', timestamp: dayEnd, fromTimestamp: String(seconds('2026-11-09T00:00:00Z') - 1) },
      { type: 'swap', asset: groups[0], limit: '50', timestamp: dayEnd, prevPageToken: `${groups[0]}@3` },
      { type: 'swap', asset: groups[0], limit: '50', timestamp: dayEnd, prevPageToken: `${groups[0]}@6` },
      { type: 'swap', asset: groups[1], limit: '50', timestamp: dayEnd, fromTimestamp: String(seconds('2026-11-09T00:00:00Z') - 1) }
    ]);
    assert.ok(midgard.calls.every((call) => call.options.bases.length === 1 && call.options.bases[0] === BASE && call.options.cooldownClient === client));
    assert.deepEqual(midgard.midgardCalls.map((call) => call.path), ['/pools',
      `/history/rune?interval=day&from=${seconds('2026-11-09T00:00:00Z')}&to=${dayEnd}`]);

    assert.deepEqual(await swapRows(client), [
      { action_key: 'CROSS', day: '2026-11-09', input_asset: USDC, input_e8: '5000000000', output_asset: TRADE_USDT, fee_rune_e8: '0' },
      { action_key: 'MIDNIGHT', day: '2026-11-09', input_asset: USDC, input_e8: '100000000000', output_asset: USDT, fee_rune_e8: '100000000' },
      { action_key: 'REFUND', day: '2026-11-09', input_asset: SECURED_USDT, input_e8: '20000000000', output_asset: USDC, fee_rune_e8: '10000000' },
      { action_key: 'STREAM', day: '2026-11-09', input_asset: USDC, input_e8: '30000000000', output_asset: TRADE_USDT, fee_rune_e8: '50000000' }
    ], 'the swap matched by both groups is stored once; out-of-day, pending and non-stable routes are dropped');
    // In-day actions: six from the first group, two from the second.
    assert.deepEqual(await dayRows(client), [{ day: '2026-11-09', rune_price_usd: '2', actions_scanned: '8', swaps: 4 }]);
    const state = await backfillState(client);
    assert.equal(state.scan_day, '2026-11-08', 'the next scan is the previous day');
    assert.equal(state.group_index, 0);
    assert.equal(state.page_token, '');
    assert.equal(state.source_base, null);
    assert.equal(state.last_error, null);
  });
});

test('the asset filter is discovered once and reused across runs', postgres, async () => {
  await withDatabase(async (client) => {
    const first = fakeMidgard();
    await advanceStableSwapBackfill(client, { ...first.options, maxPages: 1 });
    const state = await backfillState(client);
    assert.equal(state.omitted_asset, USDT);
    assert.deepEqual(state.asset_filter, ['ETH-USDC-0XA0B8', 'ETH-USDT-0XDAC1', 'ETH.USDC-0XA0B8', 'ETH~USDC-0XA0B8', TRADE_USDT]);
    assert.equal(state.target_start, '2026-08-12');
    assert.equal(state.ledger_start, '2026-11-10');

    const changed = fakeMidgard({ pools: [{ asset: 'BSC.USDC-0X8AC7', volume24h: '1' }, { asset: 'AVAX.USDT-0X97', volume24h: '2' }] });
    await advanceStableSwapBackfill(client, { ...changed.options, maxPages: 1 });
    assert.equal(changed.midgardCalls.filter((call) => call.path === '/pools').length, 0);
    assert.equal(changed.calls[0].params.asset, 'ETH-USDC-0XA0B8,ETH-USDT-0XDAC1,ETH.USDC-0XA0B8,ETH~USDC-0XA0B8');
    assert.deepEqual((await backfillState(client)).asset_filter, state.asset_filter);
  });
});

test('a failure mid-day keeps the saved token and resumes without duplicating rows', postgres, async () => {
  await withDatabase(async (client) => {
    const midgard = fakeMidgard({ failAction: (call) => (call === 2 ? new Error('provider down') : null) });
    const failed = await advanceStableSwapBackfill(client, { ...midgard.options, maxPages: 20 });
    assert.equal(failed.error, 'provider down');
    assert.equal(failed.pages, 1);
    let state = await backfillState(client);
    assert.equal(state.last_error, 'provider down');
    assert.equal(state.deferred, true);
    assert.match(state.page_token, /@3$/);
    assert.deepEqual((await swapRows(client)).map((row) => row.action_key), ['MIDNIGHT']);

    assert.deepEqual(await advanceStableSwapBackfill(client, { ...midgard.options, maxPages: 20 }),
      { status: 'waiting', pages: 0, days_completed: 0, swaps: 0 }, 'a deferred lane makes no request');
    assert.equal(midgard.calls.length, 2);

    await allow(client);
    const resumed = await advanceStableSwapBackfill(client, { ...midgard.options, maxPages: 3 });
    assert.equal(resumed.days_completed, 1);
    assert.equal(midgard.calls[2].params.prevPageToken, state.page_token);
    assert.deepEqual((await swapRows(client)).map((row) => row.action_key), ['CROSS', 'MIDNIGHT', 'REFUND', 'STREAM']);
    state = await backfillState(client);
    assert.equal(state.last_error, null);
    assert.equal(state.scan_day, '2026-11-08');
  });
});

test('a budget deferral waits until the budget reopens', postgres, async () => {
  await withDatabase(async (client) => {
    const retryAt = '2030-01-01T00:00:00.000Z';
    const deferred = Object.assign(new Error('Midgard request deferred by shared budget'), { code: 'MIDGARD_BUDGET_DEFERRED', retryAt });
    const midgard = fakeMidgard({ failAction: () => deferred });
    const result = await advanceStableSwapBackfill(client, { ...midgard.options, maxPages: 2 });
    assert.match(result.error, /deferred/);
    assert.equal((await backfillState(client)).available_at.toISOString(), retryAt);
  });
});

test('a repeated page token stops the scan', postgres, async () => {
  await withDatabase(async (client) => {
    const midgard = fakeMidgard({ token: (next) => (next ? 'same@3' : '') });
    const result = await advanceStableSwapBackfill(client, { ...midgard.options, maxPages: 5 });
    assert.match(result.error, /repeated a stable swap page token/);
    assert.equal(result.pages, 2);
    assert.equal((await backfillState(client)).page_token, 'same@3');
  });
});

test('the terminal page replays idempotently when the day cannot be finished', postgres, async () => {
  await withDatabase(async (client) => {
    const midgard = fakeMidgard({ failMidgard: (call, path) => (path.startsWith('/history/rune') && call === 2 ? new Error('price down') : null) });
    const failed = await advanceStableSwapBackfill(client, { ...midgard.options, maxPages: 4 });
    assert.equal(failed.error, 'price down');
    assert.equal(failed.days_completed, 0);
    assert.deepEqual(await dayRows(client), []);
    assert.equal((await backfillState(client)).group_index, 1, 'the last group terminal page was not committed');
    assert.deepEqual((await swapRows(client)).map((row) => row.action_key), ['CROSS', 'MIDNIGHT', 'REFUND', 'STREAM']);

    await allow(client);
    const replayed = await advanceStableSwapBackfill(client, { ...midgard.options, maxPages: 1 });
    assert.equal(replayed.days_completed, 1);
    assert.equal(midgard.calls.at(-1).params.asset, TRADE_USDT);
    assert.deepEqual((await swapRows(client)).map((row) => row.action_key), ['CROSS', 'MIDNIGHT', 'REFUND', 'STREAM']);
    assert.deepEqual(await dayRows(client), [{ day: '2026-11-09', rune_price_usd: '2', actions_scanned: '8', swaps: 4 }]);
  });
});

test('backfill scans newest day first, completes at target_start, then stays idle', postgres, async () => {
  await withDatabase(async (client) => {
    const midgard = fakeMidgard({ prices: { '2026-11-09': '2' } });
    await advanceStableSwapBackfill(client, { ...midgard.options, maxPages: 4 });
    await client.query("update dynamic_fee_stable_swap_backfill set target_start = '2026-11-08'");
    const result = await advanceStableSwapBackfill(client, { ...midgard.options, maxPages: 20 });
    assert.deepEqual(result, { status: 'done', pages: 2, days_completed: 1, swaps: 1 });
    assert.deepEqual(midgard.calls.map((call) => call.params.timestamp), [
      ...Array(4).fill(String(seconds('2026-11-10T00:00:00Z'))), ...Array(2).fill(String(seconds('2026-11-09T00:00:00Z')))]);
    assert.deepEqual(await dayRows(client), [
      { day: '2026-11-08', rune_price_usd: null, actions_scanned: '1', swaps: 1 },
      { day: '2026-11-09', rune_price_usd: '2', actions_scanned: '8', swaps: 4 }
    ]);
    assert.equal((await swapRows(client)).find((row) => row.action_key === 'BEFORE').day, '2026-11-08');
    const state = await backfillState(client);
    assert.ok(state.completed_at);
    assert.equal(state.scan_day, null);

    const calls = midgard.calls.length + midgard.midgardCalls.length;
    assert.deepEqual(await advanceStableSwapBackfill(client, midgard.options), { status: 'done', pages: 0, days_completed: 0, swaps: 0 });
    assert.equal(midgard.calls.length + midgard.midgardCalls.length, calls);
  });
});
