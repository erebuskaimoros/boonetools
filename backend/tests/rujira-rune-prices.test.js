import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRujiraRunePrices } from '../src/shared/rujira-rune-prices.js';
const NOW = '2026-09-02T12:00:00Z';
const base = 'https://midgard.example.invalid/v2';
const unix = (value) => Date.parse(value) / 1000;
function fixture() {
  const stored = new Map(); const requests = [];
  return { stored, requests, options: { now: NOW, healthNow: NOW, bases: [base],
    loadCached: async (_db, _ns, key) => {
      const row = stored.get(JSON.stringify(key));
      return row && (row.completedAt || Date.parse(row.expiresAt) > Date.parse(NOW)) ? row : null;
    },
    saveCached: async (_db, row) => { stored.set(JSON.stringify(row.identity), row); },
    fetchMidgard: async (requestPath, options) => {
      requests.push(requestPath); assert.deepEqual(options.bases, [base]);
      if (requestPath === '/health') return { database: true, inSync: true,
        lastAggregated: { height: 100, timestamp: unix(NOW) } };
      const params = new URL(requestPath, base).searchParams;
      const from = Number(params.get('from')); const to = Number(params.get('to'));
      const width = params.get('interval') === 'week' ? 7 * 86400 : 86400;
      const intervals = [];
      for (let cursor = from; cursor < to; cursor += width) intervals.push({ startTime: cursor, endTime: cursor + width, runePriceUSD: '2' });
      return { intervals };
    }
  } };
}
test('closed RUNE buckets are certified once and skipped on repeated callers', async () => {
  const f = fixture();
  const first = await loadRujiraRunePrices({}, ['2026-08-31', '2026-09-01'], f.options);
  assert.equal(first.rows.length, 2); assert.equal(first.rows.every((row) => row.completed), true);
  assert.equal(f.requests[0], '/health');
  assert.equal(f.requests.length, 2);
  f.requests.length = 0;
  const second = await loadRujiraRunePrices({}, ['2026-08-31', '2026-09-01'], f.options);
  assert.equal(second.rows.length, 2); assert.equal(f.requests.length, 0);
});
test('open bucket reuse keeps its actual observation and does not claim historical finality', async () => {
  const f = fixture();
  const first = await loadRujiraRunePrices({}, ['2026-09-02'], f.options);
  assert.equal(first.rows[0].completed, false); assert.equal(f.requests.length, 1);
  const second = await loadRujiraRunePrices({}, ['2026-09-02'], f.options);
  assert.equal(second.rows[0].observedAt, first.rows[0].observedAt); assert.equal(f.requests.length, 1);
});
test('daily and weekly pricing retain separate interval identities and values', async () => {
  const f = fixture();
  await loadRujiraRunePrices({}, ['2026-08-24'], f.options);
  await loadRujiraRunePrices({}, ['2026-08-24'], { ...f.options, interval: 'week' });
  assert.equal(f.stored.size, 2);
  assert.equal(f.requests.filter((requestPath) => requestPath.includes('interval=week')).length, 1);
});
test('lagging health or missing price cannot finalize a rounded calendar bucket', async () => {
  for (const malformed of [false, true]) {
    const f = fixture(); const fetcher = f.options.fetchMidgard;
    f.options.fetchMidgard = async (requestPath, options) => {
      if (!malformed && requestPath === '/health') return { database: true, inSync: true,
        lastAggregated: { height: 1, timestamp: unix('2026-09-01T23:59:59Z') } };
      const result = await fetcher(requestPath, options);
      if (malformed && result.intervals) result.intervals[0].runePriceUSD = null;
      return result;
    };
    const result = await loadRujiraRunePrices({}, ['2026-09-01'], f.options);
    assert.equal(f.stored.size, 0); assert.equal(result.pending_buckets, 1); assert.ok(result.errors.length);
  }
});


test('RUNE pricing recovers once a short endpoint cooldown expires within a bounded retry', async () => {
  const f = fixture(); let nowMs = Date.parse(NOW); let attempts = 0; const waits = [];
  const fetcher = f.options.fetchMidgard;
  const result = await loadRujiraRunePrices({}, ['2026-09-02'], { ...f.options,
    now: () => new Date(nowMs),
    sleep: async ms => { waits.push(ms); nowMs += ms; },
    fetchMidgard: async (route, settings) => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('short endpoint cooldown'), {
        name: 'ProviderCooldownError', skipProvider: true,
        providerKey: 'service:midgard.example.invalid/v2:midgard-history-rune',
        blockedUntil: new Date(nowMs + 1000).toISOString()
      });
      return fetcher(route, settings);
    }
  });
  assert.equal(result.rows.length, 1, 'a brief pricing cooldown must not postpone this week for another full scheduler cycle');
  assert.equal(attempts, 2);
  assert.ok(waits.reduce((a,b) => a+b, 0) >= 1000);
  assert.ok(waits.reduce((a,b) => a+b, 0) <= 120000);
});

function recoveryOptions(f, fail) {
  let clock = Date.parse(NOW);
  const waits = [];
  const calls = [];
  return { waits, calls, options: { ...f.options,
    now: () => new Date(clock),
    sleep: async ms => { waits.push(ms); clock += ms; },
    fetchMidgard: async (route, settings) => {
      calls.push(route);
      const error = fail(route, calls.length, clock);
      if (error) throw error;
      return f.options.fetchMidgard(route, settings);
    }
  } };
}
const cooldown = (clock, delay = 1000, family = 'midgard-history-rune') => Object.assign(new Error('endpoint unavailable'), {
  name: 'ProviderCooldownError', skipProvider: true,
  providerKey: `service:midgard.example.invalid/v2:${family}`,
  blockedUntil: new Date(clock + delay).toISOString()
});

test('health and history share two recovery retries instead of multiplying them for each range', async () => {
  const f = fixture();
  let healthCalls = 0;
  const r = recoveryOptions(f, (route, _attempt, clock) => route === '/health'
    ? ++healthCalls === 1 ? cooldown(clock, 1000, 'midgard-health') : null
    : cooldown(clock, 1000));
  const result = await loadRujiraRunePrices({}, ['2026-08-29', '2026-09-01'], r.options);
  assert.equal(r.calls.filter(route => route === '/health').length, 2);
  assert.equal(r.calls.length, 5, 'three baseline requests plus two shared recovery attempts');
  assert.equal(r.waits.length, 2);
  assert.equal(result.recovery_retries, 2);
  assert.equal(result.recovery_wait_ms, 2000);
  assert.equal(result.pending_buckets, 2);
  assert.equal(f.stored.size, 0);
});

test('persistent endpoint failures stop at three attempts and never wait beyond 120 seconds', async () => {
  for (const delay of [1000, 70000, 120001]) {
    const f = fixture();
    const r = recoveryOptions(f, (_route, _attempt, clock) => cooldown(clock, delay));
    const result = await loadRujiraRunePrices({}, ['2026-09-02'], r.options);
    assert.ok(r.calls.length <= 3);
    assert.equal(r.calls.length, delay === 1000 ? 3 : delay === 70000 ? 2 : 1);
    assert.ok(r.waits.reduce((sum, value) => sum + value, 0) <= 120000);
    assert.equal(result.pending_buckets, 1);
    assert.equal(f.stored.size, 0);
  }
});

test('a transport timeout retries through the same pinned provider and retains provider cache provenance', async () => {
  const f = fixture();
  const r = recoveryOptions(f, (_route, attempt) => attempt === 1 ? new DOMException('timeout', 'TimeoutError') : null);
  const result = await loadRujiraRunePrices({}, ['2026-09-02'], { ...r.options,
    bases: [base, 'https://configured-fallback.example.invalid/v2'] });
  assert.equal(result.rows.length, 1);
  assert.equal(r.calls.length, 2);
  assert.equal(r.waits.length, 1);
  assert.ok(r.waits[0] <= 120000);
  assert.equal(result.recovery_retries, 1);
  assert.equal(f.stored.size, 1);
  const cached = [...f.stored.values()][0];
  assert.equal(cached.metadata.aggregated_through, null, 'an open bucket has no fabricated completed watermark');
  // The fetch fixture asserts every request uses only the primary provider.
});

for (const [label, error] of [
  ['HTTP 429', Object.assign(new Error('provider refused'), { status: 429 })],
  ['Retry-After', Object.assign(new Error('provider unavailable'), { status: 503, retryAfterSeconds: 1 })],
  ['global cooldown', Object.assign(new Error('gateway unavailable'), { name: 'ProviderCooldownError',
    providerKey: 'global:midgard.example.invalid', blockedUntil: '2026-09-02T12:00:01Z' })],
  ['daily budget', Object.assign(new Error('admission deferred'), { code: 'MIDGARD_BUDGET_DEFERRED' })],
  ['invalid payload', new Error('Midgard returned an unusable response')]
]) {
  test(`${label} does not sleep or retry RUNE pricing`, async () => {
    const f = fixture();
    const r = recoveryOptions(f, () => error);
    const result = await loadRujiraRunePrices({}, ['2026-09-02'], r.options);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.waits, []);
    assert.equal(result.pending_buckets, 1);
    assert.equal(result.recovery_retries, 0);
    assert.equal(f.stored.size, 0);
  });
}

test('caller cancellation during a recovery wait stops acquisition immediately', async () => {
  const f = fixture();
  const controller = new AbortController();
  const r = recoveryOptions(f, (_route, _attempt, clock) => cooldown(clock));
  await assert.rejects(() => loadRujiraRunePrices({}, ['2026-09-02'], {
    ...r.options, signal: controller.signal,
    sleep: async () => { controller.abort(new Error('caller cancelled')); }
  }), /caller cancelled/);
  assert.equal(r.calls.length, 1);
  assert.equal(f.stored.size, 0);
});
