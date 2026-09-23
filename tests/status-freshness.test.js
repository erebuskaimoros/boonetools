import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeLiveStatus, statusPresentation, summarizeStatusWarnings } from '../src/lib/status/freshness.js';
const now = Date.parse('2026-09-23T21:08:34Z');
const snapshot = (state = 'signing', overrides = {}) => ({ as_of: new Date(now - 5000).toISOString(), network: { consensus: { state } }, ...overrides });
test('an expired or failed status poll cannot retain a verified stall or live indicator', () => {
  for (const state of ['stalled', 'signing']) {
    const result = statusPresentation(snapshot(state, { as_of: new Date(now - 60000).toISOString() }), now);
    assert.equal(result.consensusState, 'unknown');
    assert.equal(result.sourceLabel, 'DATA DELAYED');
  }
  assert.equal(statusPresentation(snapshot('stalled', { stale: true }), now).consensusState, 'unknown');
});
test('fresh consensus and partial auxiliary data have distinct labels', () => {
  assert.equal(statusPresentation(snapshot('stalled'), now).sourceLabel, 'NO NEW BLOCKS');
  assert.equal(statusPresentation(snapshot(), now).sourceLabel, 'LIVE');
  assert.equal(statusPresentation(snapshot('signing', { partial: true }), now).sourceLabel, 'PARTIAL DATA');
  assert.equal(statusPresentation(snapshot('unknown'), now).sourceLabel, 'DATA DELAYED');
});
test('repeated raw scanner errors produce one readable notice', () => {
  const warning = 'bifrost_scanners: Provider global:vanaheimex.com cooling down until 2026-09-23: Request failed (429); reused last successful value';
  assert.equal(summarizeStatusWarnings([warning, warning], warning), 'Scanner statistics are delayed.');
});
test('fresh dashboard publication cannot renew an old network observation', () => {
  const dashboard = snapshot('stalled', { sources: { network: { as_of: new Date(now - 120000).toISOString() } } });
  assert.equal(statusPresentation(dashboard, now).consensusState, 'unknown');
  assert.equal(statusPresentation(mergeLiveStatus(dashboard, null), now).consensusState, 'unknown');
});

test('newer dashboard network state and freshness beat an older stalled live response together', () => {
  const dashboard = snapshot('signing', {
    sources: { network: { as_of: new Date(now - 5000).toISOString() } },
    chains: [{ chain: 'BTC', trading: 'enabled' }],
    churn: { isPaused: false }
  });
  const live = snapshot('stalled', {
    as_of: new Date(now - 15000).toISOString(),
    chains: [{ chain: 'BTC', trading: 'paused' }],
    churn: { isPaused: true }
  });
  const merged = mergeLiveStatus(dashboard, live);
  assert.equal(merged.network, dashboard.network);
  assert.equal(merged.chains, dashboard.chains);
  assert.equal(merged.churn, dashboard.churn);
  assert.equal(statusPresentation(merged, now).consensusState, 'signing');
  assert.equal(statusPresentation(merged, now).sourceLabel, 'LIVE');
});

test('fresh live proof retains its own timestamp and health when merged into an older dashboard', () => {
  const dashboard = snapshot('stalled', {
    as_of: new Date(now - 120000).toISOString(),
    sources: { network: { as_of: new Date(now - 120000).toISOString() } },
    stale: true,
    partial: true
  });
  const live = snapshot('signing', {
    source: { as_of: new Date(now - 60000).toISOString() },
    stale: false
  });
  const merged = mergeLiveStatus(dashboard, live);
  assert.equal(merged.network, live.network);
  assert.equal(merged.network_observation.as_of, live.as_of);
  assert.equal(statusPresentation(merged, now).consensusState, 'signing');
  assert.equal(statusPresentation(merged, now).sourceLabel, 'PARTIAL DATA');
  assert.equal(statusPresentation(merged, now + 45000).consensusState, 'unknown');
});

test('a stale selected live observation cannot inherit fresh dashboard health', () => {
  const dashboard = snapshot('signing', {
    sources: { network: { as_of: new Date(now - 15000).toISOString() } },
    stale: false
  });
  const merged = mergeLiveStatus(dashboard, snapshot('stalled', { stale: true }));
  assert.equal(statusPresentation(merged, now).consensusState, 'unknown');
  assert.equal(statusPresentation(merged, now).sourceLabel, 'DATA DELAYED');
});

test('live-only and missing data use the same freshness rules', () => {
  assert.equal(mergeLiveStatus(null, null), null);
  assert.equal(statusPresentation(null, now).consensusState, 'unknown');
  const live = snapshot('signing', { source: { as_of: new Date(now - 60000).toISOString() } });
  assert.equal(statusPresentation(mergeLiveStatus(null, live), now).consensusState, 'signing');
  assert.equal(statusPresentation(snapshot('stalled', { as_of: new Date(now + 60000).toISOString() }), now).consensusState, 'unknown');
});
