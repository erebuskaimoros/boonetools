import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ASSET_LOGOS, getAssetLogo, getChainLogo } from '../src/lib/constants/assets.js';
import { CHAIN_ICONS, getChainIcon } from '../src/lib/utils/network.js';

const ZEC_LOGO = '/assets/chains/ZEC.svg';
const VVV_ASSET = 'BASE.VVV-0XACFE6019ED1A7DC6F7B508C02D1B04EC88CC21BF';

test('RUJI uses the existing local token artwork, not a nonexistent filename', async () => {
  assert.equal(getAssetLogo('THOR.RUJI'), '/assets/coins/RUJI.svg');
  assert.equal(getAssetLogo('thor.ruji'), '/assets/coins/RUJI.svg');
  const svg = await readFile(new URL(`../public${getAssetLogo('THOR.RUJI')}`, import.meta.url), 'utf8');
  assert.match(svg, /<svg\b/);
});

test('VVV uses its own local token logo, not the Base chain or generic fallback', () => {
  assert.equal(ASSET_LOGOS[VVV_ASSET], '/assets/coins/VVV.svg');
  for (const asset of [VVV_ASSET, VVV_ASSET.toLowerCase(), VVV_ASSET.replace('.', '~'), VVV_ASSET.replace('.', '-'), VVV_ASSET.replace('.', '/')]) {
    assert.equal(getAssetLogo(asset), '/assets/coins/VVV.svg', asset);
  }
});

test('VVV local logo is a self-contained vector asset', async () => {
  const svg = await readFile(new URL('../public/assets/coins/VVV.svg', import.meta.url), 'utf8');
  assert.match(svg, /<svg\b/);
  assert.match(svg, /viewBox=/);
  assert.doesNotMatch(svg, /<script\b|<foreignObject\b|<image\b/i);
});

test('ZEC uses the same local logo in native asset and chain views', () => {
  assert.equal(ASSET_LOGOS['ZEC.ZEC'], ZEC_LOGO);
  assert.equal(getAssetLogo('ZEC.ZEC'), ZEC_LOGO);
  assert.equal(getAssetLogo('zec.zec'), ZEC_LOGO);
  assert.equal(getChainLogo('ZEC'), ZEC_LOGO);
  assert.equal(getChainLogo('zec'), ZEC_LOGO);
  assert.equal(CHAIN_ICONS.ZEC, ZEC_LOGO);
  assert.equal(getChainIcon('ZEC'), ZEC_LOGO);
});

test('ZEC logo resolves for trade, secured, and synth representations', () => {
  for (const asset of ['ZEC~ZEC', 'ZEC-ZEC', 'ZEC/ZEC', 'zec~zec', 'zec-zec', 'zec/zec']) {
    assert.equal(getAssetLogo(asset), ZEC_LOGO, asset);
  }
});

test('the direct chain icon URL has a local vector asset', async () => {
  const svg = await readFile(new URL('../public/assets/chains/ZEC.svg', import.meta.url), 'utf8');
  assert.match(svg, /<svg\b/);
  assert.match(svg, /viewBox=/);
  assert.match(svg, /<path\b/);
  assert.doesNotMatch(svg, /<script\b|<foreignObject\b|<image\b|https?:\/\/(?!www\.w3\.org\/2000\/svg)/i);
});

test('existing asset logos and unknown-asset fallbacks are preserved', () => {
  assert.equal(getAssetLogo('BTC.BTC'), '/assets/coins/bitcoin-btc-logo.svg');
  assert.equal(getAssetLogo('ETH.ETH'), '/assets/coins/ethereum-eth-logo.svg');
  assert.equal(getAssetLogo('THOR.RUNE'), '/assets/coins/RUNE-ICON.svg');
  assert.equal(getAssetLogo('ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48'), '/assets/coins/usd-coin-usdc-logo.svg');
  assert.equal(getAssetLogo('UNKNOWN.UNKNOWN'), '');
  assert.equal(getAssetLogo(''), '');
  assert.equal(getChainLogo('UNKNOWN'), '');
});
