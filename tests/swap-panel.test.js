import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { STO_WIDGET_API_KEY, isSwapShortcut, stoWidgetUrl } from '../src/lib/swap/sto-widget.js';

const key = (value, extra = {}) => ({ key: value, target: { tagName: 'BODY' }, ...extra });

test('frames the STO widget page with the affiliate key and a pinned dark theme', () => {
  assert.equal(stoWidgetUrl('abc 123&x'), 'https://swap.thorchain.org/widget?apiKey=abc+123%26x&theme=dark');
  assert.equal(stoWidgetUrl('k', { origin: 'http://localhost:3000', theme: 'light' }), 'http://localhost:3000/widget?apiKey=k&theme=light');
});

test('no configured key means no swap button (Node has no Vite env)', () => {
  assert.equal(STO_WIDGET_API_KEY, '');
});

test('a bare S toggles the panel except while typing or with a modifier', () => {
  assert.equal(isSwapShortcut(key('s')), true);
  assert.equal(isSwapShortcut(key('S')), true);
  assert.equal(isSwapShortcut(key('d')), false);
  assert.equal(isSwapShortcut(key('s', { metaKey: true })), false);
  assert.equal(isSwapShortcut(key('s', { ctrlKey: true })), false);
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(isSwapShortcut(key('s', { target: { tagName } })), false);
  }
  assert.equal(isSwapShortcut(key('s', { target: { tagName: 'DIV', isContentEditable: true } })), false);
});

test('the footer launches the swap panel instead of linking to THORDEX', async () => {
  const [footer, app, panel] = await Promise.all(
    ['../src/lib/Footer.svelte', '../src/App.svelte', '../src/lib/swap/SwapPanel.svelte']
      .map((file) => readFile(new URL(file, import.meta.url), 'utf8'))
  );
  assert.doesNotMatch(footer, /thordex/i);
  assert.match(footer, /id="swap-launcher"[\s\S]*aria-controls="swap-panel"[\s\S]*aria-keyshortcuts="S"/);
  assert.match(footer, /\{#if STO_WIDGET_API_KEY\}/);
  assert.match(footer, /<span class="swap-label">swap on THORChain<\/span>/);
  // Mounted beside the footer, outside the routed component, and never in the desktop app.
  assert.match(app, /\{#if !isDesktopApp\}\s*<Footer \/>[\s\S]*?<SwapPanel \/>\s*\{\/if\}/);
  assert.match(panel, /id="swap-panel"/);
  assert.match(panel, /aria-modal="false"/);
});
