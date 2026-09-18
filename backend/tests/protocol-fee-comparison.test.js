import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveComparisonDay, parseNearEmissions, priceDays, buildComparisonPayload, collectComparison, emptyComparisonCache } from '../src/protocol-fee-comparison/collector.js';
import { CHAINFLIP_20210_CODE_HASH, createChainflipReader, decodeLittleEndian, sumIssuanceSegments } from '../src/protocol-fee-comparison/chainflip.js';
import { handleProtocolFeeComparison } from '../src/handlers/protocol-fee-comparison.js';
import { comparisonRequest } from '../src/jobs/protocol-fee-comparison.js';
import { requestFromProviders } from '../../shared/provider-client.js';
import { readComparisonCache, saveComparisonCache } from '../../scripts/dev-protocol-fee-comparison.mjs';
import { FEE_WALLETS, nearEpochMint, nearWalletDays } from '../src/protocol-fee-comparison/near.js';

test('retained NEAR income includes its frontend exactly once; subsidies and signed reserve residuals survive', () => {
  const row = deriveComparisonDay('2026-09-17', {
    earnings: { liquidityFees: '10000000000', blockRewards: '-1000000', runePriceUSD: '2' },
    wallets: { frontend_near: 1, other_near: 3 }, nearRevenue: 100, nearPrice: 2, nearIssuance: 200,
    chainflipRevenue: 30, flipPrice: .5, flipIssuance: { atomic: '20000000000000000000' }
  });
  assert.equal(row.thorchain.netUsd, 200.02);
  assert.deepEqual(row.near, { incomeUsd: 100, frontendIncomeUsd: 25, otherIncomeUsd: 75, subsidyUsd: 400, netUsd: -300 });
  assert.deepEqual(row.chainflip, { incomeUsd: 30, subsidyUsd: 10, netUsd: 20 });
  assert.equal(deriveComparisonDay('2026-09-17', { nearRevenue: 0 }).near.netUsd, null);
  assert.equal(deriveComparisonDay('2026-09-17', { chainflipRevenue: 30, flipPrice: .5 }).chainflip.netUsd, null);
});

test('NEAR frontend allocation handles zero receipts and refuses missing or inconsistent observations', () => {
  const raw = { nearRevenue: 100, nearPrice: 2, nearIssuance: 200 };
  const derive = wallets => deriveComparisonDay('2026-09-17', { ...raw, wallets }).near;
  assert.equal(derive({ frontend_near: 4, other_near: 0 }).incomeUsd, 100);
  assert.equal(derive({ frontend_near: 4, other_near: 0 }).frontendIncomeUsd, 100);
  assert.equal(derive({ frontend_near: 0, other_near: 4 }).frontendIncomeUsd, 0);
  for (const wallets of [undefined, { frontend_near: 1 }, { frontend_near: -1, other_near: 3 }, { frontend_near: 0, other_near: 0 }]) {
    assert.equal(derive(wallets).incomeUsd, null);
    assert.equal(derive(wallets).frontendIncomeUsd, null);
  }
  const zero = deriveComparisonDay('2026-09-17', { ...raw, nearRevenue: 0, wallets: { frontend_near: 0, other_near: 0 } }).near;
  assert.deepEqual(zero, { incomeUsd: 0, frontendIncomeUsd: 0, otherIncomeUsd: 0, subsidyUsd: 400, netUsd: -400 });
});

test('NEAR server props are decoded as JSON without executing script and missing model fails closed', () => {
  const data = { emissionsDaily: [{ date: '2026-09-17', value: 123 }] };
  const html = `<script>self.__next_f.push(${JSON.stringify([1, `18:${JSON.stringify(data)}`])})</script>`;
  assert.deepEqual(parseNearEmissions(html), data.emissionsDaily);
  assert.throws(() => parseNearEmissions('<script>alert(1)</script>'), /unavailable/);
});

test('NEAR dashboard YTD issuance is differenced only from a continuous Jan 1 baseline', () => {
  const data = { emissionsDaily: [{ date: '2026-09-17', value: 123 }], absoluteRevEmissions: [
    { date: '2026-01-01', emissionsNear: 100 }, { date: '2026-01-02', emissionsNear: 215 },
    { date: '2026-01-04', emissionsNear: 420 }
  ] };
  assert.deepEqual(parseNearEmissions(JSON.stringify(data)), [
    { date: '2026-01-01', value: 100 }, { date: '2026-01-02', value: 115 }, ...data.emissionsDaily
  ]);
  data.absoluteRevEmissions.shift();
  assert.deepEqual(parseNearEmissions(JSON.stringify(data)), data.emissionsDaily);
});

test('prices use historical UTC midnight with bounded tolerance, no present-price fallback', () => {
  const timestamp = Date.parse('2026-09-17') / 1000;
  const payload = { coins: { 'coingecko:chainflip': { prices: [{ timestamp: timestamp + 100, price: .4 }, { timestamp: timestamp + 12 * 3600, price: 99 }] } } };
  assert.deepEqual(priceDays(payload), { 'coingecko:chainflip': { '2026-09-17': .4 } });
});

test('issuance arithmetic is exact beyond JS safe integers, inclusive start and exclusive end', () => {
  assert.equal(sumIssuanceSegments(100, 200, [{ height: 100, amount: '9007199254740993' }, { height: 150, amount: '0' }]), '450359962737049650');
  assert.equal(decodeLittleEndian('0x0100000000000000'), 1n);
  assert.throws(() => sumIssuanceSegments(100, 200, []), /Incomplete/);
});

function rpcFixture(specVersion = 20213, codeHash = CHAINFLIP_20210_CODE_HASH, backupRate = '0x0') {
  const startTime = Date.parse('2026-09-17');
  const calls = [];
  const hash = (height) => `0x${height.toString(16).padStart(64, '0')}`;
  const request = async (_url, { body }) => body.map(({ id, method, params }) => {
    calls.push(method);
    const height = Number(BigInt(params.at(-1) || 0));
    let result;
    if (method === 'chain_getFinalizedHead') result = hash(16000);
    else if (method === 'chain_getHeader') result = { number: `0x${height.toString(16)}` };
    else if (method === 'chain_getBlockHash') result = hash(params[0]);
    else if (method === 'state_getStorage') result = '0x' + BigInt(startTime + (height - 1000) * 6000).toString(16).padStart(16, '0').match(/../g).reverse().join('');
    else if (method === 'state_getRuntimeVersion') result = { specName: 'chainflip-node', specVersion };
    else if (method === 'state_getStorageHash') result = codeHash;
    else if (method === 'cf_authority_emission_per_block') result = `0x${(100n + BigInt(Math.floor(height / 150))).toString(16)}`;
    else if (method === 'cf_backup_emission_per_block') result = backupRate;
    else throw new Error(method);
    return { id, result };
  }).reverse(); // JSON-RPC batch responses need not preserve request order.
  return { request, calls };
}

test('archive reader finds exact UTC boundaries and sums every historical emission segment', async () => {
  const fixture = rpcFixture();
  const reader = createChainflipReader(fixture);
  const row = await reader.issuance('2026-09-17');
  let expected = 0n;
  for (let height = 1000; height < 15400; height++) expected += 100n + BigInt(Math.floor(height / 150));
  assert.equal(row.atomic, expected.toString());
  assert.equal(row.start.height, 1000); assert.equal(row.end.height, 15400);
  assert.ok(row.checkpoints.length > 90);
  assert.ok(!fixture.calls.includes('cf_flip_supply'), 'gross issuance is not a net-supply proxy');
});

test('unreviewed Chainflip runtime fails closed rather than assuming continued or zero issuance', async () => {
  await assert.rejects(createChainflipReader(rpcFixture(20300)).issuance('2026-09-17'), /needs issuance review/);
});

test('legacy Chainflip pays the preceding block rate and refuses nonzero unaccounted backup emissions', async () => {
  const row = await createChainflipReader(rpcFixture(11006)).issuance('2026-09-17');
  let expected = 0n;
  for (let height = 1000; height < 15400; height++) expected += 100n + BigInt(Math.floor((height - 1) / 150));
  assert.equal(row.atomic, expected.toString());
  assert.equal(row.method, 'historical-onchain-legacy-emission-segments-v1');
  await assert.rejects(createChainflipReader(rpcFixture(11006, CHAINFLIP_20210_CODE_HASH, '0x1')).issuance('2026-09-17'), /backup rewards/);
});

test('indexed Chainflip date boundaries are verified against the archive before reuse', async () => {
  const boundaries = { '2026-09-17': { height: 1001, hash: 'bad', source: 'chainflip-explorer-boundary' } };
  await assert.rejects(createChainflipReader({ ...rpcFixture(), boundaries }).boundary('2026-09-17'), /Unverified/);
});

test('untagged 20210 is accepted only with the reviewed deployed WASM hash', async () => {
  const result = await createChainflipReader(rpcFixture(20210)).issuance('2026-09-17');
  assert.deepEqual(result.runtimes, [20210]);
  await assert.rejects(createChainflipReader(rpcFixture(20210, '0xunknown')).issuance('2026-09-17'),
    { code: 'CHAINFLIP_RUNTIME_REVIEW' });
});

test('backfill checkpoints survive failures and unreviewed days do not starve later reviewed days', async () => {
  const cache = emptyComparisonCache(), seen = [], saved = [];
  const reader = { boundaries: {}, issuance: async (day) => {
    seen.push(day);
    if (day === '2026-08-01') throw Object.assign(new Error('Unreviewed version'), { code: 'CHAINFLIP_RUNTIME_REVIEW' });
    return { atomic: '12', start: { height: 1 }, end: { height: 3 } };
  } };
  const run = () => collectComparison({ cache, now: Date.parse('2026-08-04'), startDay: '2026-08-01',
    request: async () => { throw new Error('offline'); }, chainflipReader: reader,
    save: async (current) => { saved.push(structuredClone(current)); } });
  await run();
  assert.ok(!cache.days['2026-08-01']);
  assert.equal(cache.days['2026-08-03'].flipIssuance.atomic, '12');
  assert.ok(saved.some((row) => row.days['2026-08-03']?.flipIssuance && !row.days['2026-08-02']), 'current days are acquired before older history');
  seen.length = 0;
  await run();
  assert.deepEqual(seen, ['2026-08-01']);
});

test('empty, failed or stale acquisition does not fabricate monthly results', async () => {
  const cache = emptyComparisonCache();
  let saves = 0;
  const { payload } = await collectComparison({ cache, now: Date.parse('2026-08-02'), maxFlipDays: 0,
    request: async () => { throw new Error('offline'); }, save: async () => { saves++; } });
  assert.deepEqual(payload.months, []);
  assert.equal(payload.stale, true);
  assert.ok(payload.errors.length >= 5);
  assert.ok(saves > 0);
  assert.deepEqual(buildComparisonPayload(cache, { now: Date.parse('2026-08-02') }).months, []);
});

test('collector aligns independently refreshed daily sources and preserves verified data through an outage', async () => {
  const cache = emptyComparisonCache();
  const start = Date.parse('2026-08-01') / 1000;
  const days = ['2026-08-01', '2026-08-02'];
  let walletParameters;
  const request = async (url) => {
    if (url.endsWith('/health')) return { lastAggregated: { timestamp: start + 2 * 86400 } };
    if (url.includes('/history/earnings')) return { intervals: days.map((_, i) => ({
      startTime: start + i * 86400, endTime: start + (i + 1) * 86400,
      liquidityFees: '10000000000', blockRewards: '100000000', runePriceUSD: '2'
    })) };
    if (url.includes('/summary/fees/')) return { totalDataChart: [[start, 100], [start + 86400, 100]] };
    if (url === 'https://revenue.near.org/') return JSON.stringify({ emissionsDaily: days.map((date) => ({ date, value: 200 })) });
    if (url.includes('coins.llama.fi/')) return { coins: Object.fromEntries(['near', 'chainflip'].map((coin) => [
      `coingecko:${coin}`, { prices: days.map((_, i) => ({ timestamp: start + i * 86400, price: 1 })) }
    ])) };
    throw new Error(`Unexpected URL ${url}`);
  };
  const result = await collectComparison({ cache, now: Date.parse('2026-08-03'), startDay: '2026-08-01', request,
    nearIssuanceReader: async () => days.map(day => ({ day, nearIssuance: 200 })),
    walletQuery: async (id, parameters) => {
      assert.equal(id, '8767542'); walletParameters = parameters;
      return { rows: days.map((day) => ({ day, frontend_near: 1, other_near: 3 })), executionId: 'verified-fixture' };
    }, chainflipReader: { boundaries: {}, issuance: async () => ({ atomic: '10000000000000000000', start: { height: 1 }, end: { height: 3 } }) } });
  assert.deepEqual(walletParameters, { start_date: '2026-08-01', end_date: '2026-08-03' });
  assert.equal(result.payload.stale, false);
  assert.equal(result.payload.throughDay, '2026-08-02');
  const points = result.payload.months[0].protocols;
  assert.equal(points.thorchain.netUsd, 396);
  assert.equal(points.near.netUsd, -200);
  assert.equal(points.near.frontendIncomeUsd, 50);
  assert.equal(points.near.otherIncomeUsd, 150);
  assert.equal(result.payload.methodology, 'swap-income-less-gross-network-subsidy-v2');
  assert.equal(points.chainflip.netUsd, 180);
  const failed = await collectComparison({ cache, now: Date.parse('2026-08-03'), startDay: '2026-08-01', request: async () => { throw new Error('offline'); } });
  assert.equal(failed.payload.stale, true);
  assert.deepEqual(failed.payload.months, result.payload.months);
});

test('public NEAR transfers page completely and exclude internal transfers, contract-call deposits and unrelated assets', async () => {
  const make = (extra = {}) => ({ account_id: FEE_WALLETS[0], amount: '1000000000000000000000000',
    asset_id: 'native:near', transfer_type: 'NativeTransfer', block_timestamp: String(BigInt(Date.parse('2026-08-01')) * 1000000n),
    receipt_id: 'receipt', transfer_index: 0, other_account_id: 'intents.near', ...extra });
  const calls = [];
  const rows = await nearWalletDays(async (_url, { body }) => {
    calls.push(body);
    if (body.account_id !== FEE_WALLETS[0]) return { transfers: [], resume_token: null };
    if (body.resume_token) return { transfers: [make({ receipt_id: 'wrap', asset_id: 'nep141:wrap.near' })], resume_token: null };
    return { transfers: [make(), make({ transfer_type: 'AttachedDeposit' }), make({ other_account_id: FEE_WALLETS[2] }),
      make({ asset_id: 'nep141:usdt.near' }), make({ amount: '-100' })], resume_token: 'page-2' };
  }, '2026-08-01', '2026-08-03');
  assert.equal(rows[0].frontend_near, 2);
  assert.equal(rows[0].other_near, 0);
  assert.equal(rows[1].frontend_near, 0, 'explicit zero only after every wallet has completed pagination');
  assert.equal(calls.length, 4);
  assert.deepEqual({ ...calls[1], resume_token: undefined }, { ...calls[0], resume_token: undefined });
  await assert.rejects(nearWalletDays(async () => ({ transfers: [], resume_token: 'loop' }), '2026-08-01', '2026-08-02'), /did not advance/);
  await assert.rejects(nearWalletDays(async () => ({ transfers: [] }), '2026-08-01', '2026-08-02'), /Incomplete/);
});

test('NEAR gross epoch mint adds only newly included chunk burns, without relying on an annual inflation rate', () => {
  const previous = { header: { height: 99, hash: 'previous', epoch_id: 'old', total_supply: '100000000000000000000000000000' } };
  const block = { header: { height: 101, hash: 'first', prev_height: 99, prev_hash: 'previous', epoch_id: 'new',
    latest_protocol_version: 86, total_supply: '100000000000000000000000001500', timestamp_nanosec: '1789603200000000000' },
    chunks: [{ height_included: 101, balance_burnt: '500' }, { height_included: 99, balance_burnt: '9000' }] };
  assert.equal(nearEpochMint(block, previous).atomic, '2000');
  assert.equal(nearEpochMint(block, previous).burnedAtomic, '500');
  assert.throws(() => nearEpochMint({ ...block, header: { ...block.header, latest_protocol_version: 87 } }, previous), /Unverified/);
  assert.throws(() => nearEpochMint({ ...block, header: { ...block.header, epoch_id: 'old' } }, previous), /Unverified/);
});

test('public GET is provider-free and ages cached snapshots', async () => {
  const cold = await handleProtocolFeeComparison({}, null, { getReadModel: async () => null });
  assert.equal(cold.status, 503);
  const result = await handleProtocolFeeComparison({}, null, { now: () => Date.parse('2026-09-20'),
    getReadModel: async () => ({ payload: { months: [{ protocols: { thorchain: { netUsd: 1 } } }], throughDay: '2026-09-17', stale: false }, stale: false }) });
  assert.equal(result.body.stale, true);
  assert.match(result.headers['Cache-Control'], /max-age=60/);
  const source = await readFile(new URL('../src/handlers/protocol-fee-comparison.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fetch\(|collector|requestFromProviders/);
});

test('source transport is bounded, allowlisted and uses the existing provider lifecycle', async () => {
  let request;
  const fetchSource = comparisonRequest({}, { transport: async (args) => { request = args; } });
  await fetchSource('https://mainnet-archive.chainflip.io', { method: 'POST', body: [{ id: 1 }] });
  assert.equal(request.timeoutMs, 45000); assert.equal(request.request.method, 'POST');
  assert.equal(typeof request.beforeRequest, 'function');
  assert.throws(() => fetchSource('https://example.com/private'), /not allowlisted/);
});

test('expected public HTML is opt-in while API HTML and marked challenges remain rejected', async () => {
  const options = { bases: ['https://revenue.near.org'], responseType: 'text',
    fetchImpl: async () => new Response('<html>public dashboard</html>', { headers: { 'content-type': 'text/html' } }) };
  await assert.rejects(requestFromProviders(options), /Challenge/);
  assert.match(await requestFromProviders({ ...options, allowHtml: true }), /public dashboard/);
  await assert.rejects(requestFromProviders({ ...options, allowHtml: true, fetchImpl: async () => new Response('challenge', {
    headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } }) }), /Challenge/);
});

test('development acquisition checkpoints preserve the last published snapshot', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'protocol-comparison-test-'));
  const file = path.join(directory, 'state.json');
  try {
    const cache = emptyComparisonCache();
    assert.equal((await readComparisonCache(file)).payload, null);
    await saveComparisonCache(cache, { throughDay: '2026-09-17' }, file);
    cache.days['2026-09-18'] = { nearRevenue: 123 };
    await saveComparisonCache(cache, undefined, file);
    const current = await readComparisonCache(file);
    assert.equal(current.payload.throughDay, '2026-09-17');
    assert.equal(current.cache.days['2026-09-18'].nearRevenue, 123);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
