import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';
import { ASSET_LOGOS, CHAIN_LOGOS, getAssetLogo } from '../src/lib/constants/assets.js';
import { normalizeAsset, getChainFromAsset } from '../shared/blockchain.js';

const assets = {
  'ZEC.ZEC': '/assets/chains/ZEC.svg',
  'THOR.RUJI': '/assets/coins/RUJI.svg',
  'BASE.VVV-0XACFE6019ED1A7DC6F7B508C02D1B04EC88CC21BF': '/assets/coins/VVV.svg'
};

// Exercise the actual pure logo lookups, without mounting unrelated providers,
// wallets, timers, or charts. AST ranges keep this independent of formatting.
function componentLookups(file, names) {
  const source = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), 'utf8');
  const body = parse(source).instance.content.body;
  const selected = names.map((name) => {
    const statement = body.find((entry) => entry.type === 'FunctionDeclaration' && entry.id.name === name);
    if (statement) return source.slice(statement.start, statement.end);
    const declaration = body.flatMap((entry) => entry.type === 'VariableDeclaration' ? entry.declarations : [])
      .find((entry) => entry.id.name === name);
    assert.ok(declaration?.init, `${file} must define ${name}`);
    return `const ${name} = ${source.slice(declaration.init.start, declaration.init.end)};`;
  });
  return runInNewContext(`${selected.join('\n')}\n({${names.join(',')}})`, {
    ASSET_LOGOS, SHARED_ASSET_LOGOS: ASSET_LOGOS, CHAIN_LOGOS,
    getAssetLogo, getSharedAssetLogo: getAssetLogo, normalizeAsset, getChainFromAsset
  });
}

function assertAssetLogos(resolve) {
  for (const [asset, expected] of Object.entries(assets)) {
    assert.equal(`/${resolve(asset).replace(/^\//, '')}`, expected, asset);
  }
}

for (const file of ['LimitOrders.svelte', 'limit-orders/ThorchainPairChart.svelte']) {
  test(`${file} resolves native and trade token icons before chain fallbacks`, () => {
    const { getAssetIcon } = componentLookups(file, ['shortAsset', 'assetIconMap', 'chainIconMap', 'getAssetIcon']);
    assertAssetLogos(getAssetIcon);
    assertAssetLogos((asset) => getAssetIcon(asset.replace('.', '~')));
    assert.equal(getAssetIcon('THOR.RUNE'), '/assets/coins/thorchain-rune-logo.svg', 'preserve legacy RUNE artwork');
    assert.equal(getAssetIcon('UNKNOWN.UNKNOWN'), '/assets/coins/fallback-logo.svg');
  });
}

for (const [file, name] of [
  ['SaversYield.svelte', 'assetLogos'],
  ['SwapEstimator.svelte', 'assetLogos'],
  ['Thorswap.svelte', 'ASSET_LOGOS']
]) {
  test(`${file} inherits all repaired token mappings`, () => {
    const lookups = componentLookups(file, [name]);
    assertAssetLogos((asset) => lookups[name][asset]);
    assert.equal(lookups[name]['BTC.BTC'], 'assets/coins/bitcoin-btc-logo.svg');
    assert.equal(lookups[name]['UNKNOWN.UNKNOWN'], undefined, 'preserve consumer fallback behavior');
  });
}

test('SaversPosition resolves repaired tokens and preserves generic fallback', () => {
  const { getAssetLogo: resolve } = componentLookups('SaversPosition.svelte', ['getAssetLogo']);
  assertAssetLogos(resolve);
  assert.equal(resolve('BTC.BTC'), '/assets/coins/bitcoin-btc-logo.svg');
  assert.equal(resolve('UNKNOWN.UNKNOWN'), '/assets/coins/fallback-logo.svg');
});

test('OraclePrice handles repaired asset logos, ZEC chain badges, and its oracle fallback', () => {
  const { getAssetLogo: resolve, chainLogos } = componentLookups('OraclePrice.svelte', ['getAssetLogo', 'chainLogos']);
  assertAssetLogos(resolve);
  assert.equal(chainLogos.ZEC, '/assets/chains/ZEC.svg');
  assert.equal(resolve('UNKNOWN.UNKNOWN', 'BTC'), 'assets/coins/bitcoin-btc-logo.svg');
  assert.equal(resolve('UNKNOWN.UNKNOWN'), 'assets/coins/fallback-logo.svg');
});

test('LendingEstimator uses shared artwork for newly supported logo mappings', () => {
  const { getLogoUrl } = componentLookups('LendingEstimator.svelte', ['assetLogos', 'getLogoUrl']);
  assertAssetLogos(getLogoUrl);
  assert.equal(getLogoUrl('UNKNOWN.UNKNOWN'), 'https://cryptologos.cc/logos/thorchain-rune-logo.svg');
});

test('WhaleWatching retains full token identifiers for native and trade logos', () => {
  const { getAssetIcon, chainIcons } = componentLookups('WhaleWatching.svelte', ['assetIcons', 'chainIcons', 'cleanAssetName', 'getAssetIcon']);
  assertAssetLogos(getAssetIcon);
  assertAssetLogos((asset) => getAssetIcon(asset.replace('.', '~')));
  assert.equal(chainIcons.ZEC, '/assets/chains/ZEC.svg');
  assert.equal(getAssetIcon('UNKNOWN.UNKNOWN'), '/assets/coins/fallback-logo.svg');
  const source = readFileSync(new URL('../src/lib/WhaleWatching.svelte', import.meta.url), 'utf8');
  for (const side of ['from', 'to']) assert.ok(source.includes(`getAssetIcon(whale.${side}.originalAsset)`));
});

test('RunePool resolves token artwork from full asset IDs, not display labels or chains', () => {
  const { getPoolLogo } = componentLookups('RunePool.svelte', ['chainIcons', 'getPoolLogo']);
  assertAssetLogos((asset) => getPoolLogo({ asset, pool: asset.split('.')[1].split('-')[0] }));
  assert.equal(getPoolLogo({ pool: 'BTC' }), '/assets/coins/bitcoin-btc-logo.svg');
  assert.equal(getPoolLogo({ pool: 'UNKNOWN' }), '/assets/coins/fallback-logo.svg');
  const source = readFileSync(new URL('../src/lib/RunePool.svelte', import.meta.url), 'utf8');
  assert.match(source, /asset:\s*pos\.pool/);
  assert.match(source, /src=\{getPoolLogo\(pool\)\}/);
});

test('TokenWhitelist identifies the Base VVV contract with its shared local logo', () => {
  const { TOKEN_METADATA } = componentLookups('TokenWhitelist.svelte', ['TOKEN_METADATA']);
  const metadata = TOKEN_METADATA['0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf'];
  assert.equal(metadata.symbol, 'VVV');
  assert.equal(metadata.logoURI, '/assets/coins/VVV.svg');
});
