import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'svelte/compiler';
import {
  COMPACT_MAX_WIDTH, LAYOUT_STORAGE_KEY, getTrackerStorage,
  loadLayoutPreference, saveLayoutPreference, isCompactLayout
} from '../src/lib/position-tracker/layout.js';

function memoryStorage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('the default stays responsive; opting into mobile also works on desktop', () => {
  for (const preference of ['auto', 'mobile']) {
    assert.equal(isCompactLayout(375, preference), true);
    assert.equal(isCompactLayout(COMPACT_MAX_WIDTH, preference), true);
  }
  assert.equal(isCompactLayout(COMPACT_MAX_WIDTH + 1, 'auto'), false);
  assert.equal(isCompactLayout(1440, 'auto'), false);
  assert.equal(isCompactLayout(1440, 'mobile'), true);
});

test('the view survives reloads in both directions without overwriting other preferences', () => {
  const storage = memoryStorage();
  storage.setItem('position_tracker_tab', 'tcy');
  storage.setItem('position_tracker_addresses', 'existing addresses');
  assert.equal(loadLayoutPreference(storage), 'auto');
  saveLayoutPreference('mobile', storage);
  assert.equal(loadLayoutPreference(storage), 'mobile');
  assert.equal(isCompactLayout(375, loadLayoutPreference(storage)), true);
  assert.equal(isCompactLayout(1440, loadLayoutPreference(storage)), true);
  saveLayoutPreference('auto', storage);
  assert.equal(loadLayoutPreference(storage), 'auto');
  assert.equal(storage.getItem('position_tracker_tab'), 'tcy');
  assert.equal(storage.getItem('position_tracker_addresses'), 'existing addresses');
});

test('invalid or unavailable storage falls back to the responsive default', () => {
  const storage = memoryStorage();
  for (const value of ['', 'desktop', 'true', '{}']) {
    storage.setItem(LAYOUT_STORAGE_KEY, value);
    assert.equal(loadLayoutPreference(storage), 'auto');
  }
  const blocked = {
    getItem() { throw new Error('Storage denied'); },
    setItem() { throw new Error('Storage full'); }
  };
  assert.equal(loadLayoutPreference(blocked), 'auto');
  assert.equal(loadLayoutPreference(null), 'auto');
  assert.doesNotThrow(() => saveLayoutPreference('mobile', blocked));
  assert.doesNotThrow(() => saveLayoutPreference('mobile', null));
});

test('storage discovery is safe during SSR and when the browser blocks the storage getter', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    delete globalThis.window;
    assert.equal(getTrackerStorage(), null);
    const blockedWindow = {};
    Object.defineProperty(blockedWindow, 'localStorage', { get() { throw new Error('SecurityError'); } });
    globalThis.window = blockedWindow;
    assert.equal(getTrackerStorage(), null);
    assert.equal(loadLayoutPreference(), 'auto');
    assert.doesNotThrow(() => saveLayoutPreference('mobile'));
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else delete globalThis.window;
  }
});

const source = readFileSync(new URL('../src/lib/PositionTracker.svelte', import.meta.url), 'utf8');
const ast = parse(source);

test('the real toggle changes only layout and remains usable if persistence fails', () => {
  const toggle = ast.instance.content.body.find((node) => node.type === 'FunctionDeclaration' && node.id.name === 'toggleLayout');
  assert.ok(toggle, 'tracker must provide its layout toggle');
  const storage = { setItem() { throw new Error('Storage denied'); } };
  const context = vm.createContext({
    layoutPreference: 'auto', activeTab: 'tcy', tracked: [{ address: 'unchanged' }],
    focusAddress: 'unchanged', saveLayoutPreference: (value) => saveLayoutPreference(value, storage)
  });
  vm.runInContext(source.slice(toggle.start, toggle.end), context);
  const tracked = context.tracked;
  vm.runInContext('toggleLayout()', context);
  assert.equal(context.layoutPreference, 'mobile');
  vm.runInContext('toggleLayout()', context);
  assert.equal(context.layoutPreference, 'auto');
  assert.equal(context.activeTab, 'tcy');
  assert.equal(context.focusAddress, 'unchanged');
  assert.equal(context.tracked, tracked);
});

test('the tracker initializes its preference and uses one existing compact layout', () => {
  assert.match(source, /let layoutPreference = loadLayoutPreference\(\)/);
  assert.match(source, /compact = isCompactLayout\(viewportWidth, layoutPreference\)/);
  assert.match(source, /on:click=\{toggleLayout\}/);
  assert.match(source, /aria-label=\{compact \? 'Use desktop view' : 'Use mobile view'\}/);
  assert.match(source, /viewportWidth > COMPACT_MAX_WIDTH/);
});
