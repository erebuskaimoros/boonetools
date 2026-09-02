import test from 'node:test';
import assert from 'node:assert/strict';

function database() {
  const rows = new Map();
  return { rows, async query(sql, params = []) {
    const key = `${params[0]}:${params[1]}`;
    if (sql.includes('pg_advisory')) return { rows: [{ locked: true }] };
    if (sql.includes('from source_observations')) return { rows: rows.has(key) ? [rows.get(key)] : [] };
    if (sql.includes('insert into source_observations')) {
      const old = rows.get(key);
      if (old?.completed_at && !(params[8] && params[6])) return { rows: [old], rowCount: 0 };
      const row = { namespace: params[0], identity: params[1], payload_json: JSON.parse(params[2]),
        source: params[3], observed_at: params[4], expires_at: params[5], completed_at: params[6],
        metadata_json: JSON.parse(params[7]) };
      rows.set(key, row);
      return { rows: [row], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
}

test('completed source observations survive expiry and reject partial overwrites', async () => {
  const { saveAcquisition, loadAcquisition } = await import('../src/shared/acquisition-cache.js');
  const client = database();
  await saveAcquisition(client, { namespace: 'price', identity: 'day', payload: { price: 2 },
    source: 'fixture', observedAt: '2026-09-02T00:00:00Z', completedAt: '2026-09-02T00:00:00Z' });
  await saveAcquisition(client, { namespace: 'price', identity: 'day', payload: { price: null },
    source: 'fixture', expiresAt: '2026-09-02T00:01:00Z' }, { force: true });
  assert.equal((await loadAcquisition(client, 'price', 'day', { nowMs: Date.parse('2027-01-01') })).payload.price, 2);
});

test('expiry cannot certify incomplete observations and force repairs require complete replacements', async () => {
  const { saveAcquisition, loadAcquisition } = await import('../src/shared/acquisition-cache.js');
  const client = database();
  await saveAcquisition(client, { namespace: 'price', identity: 'open', payload: { price: 2 },
    source: 'fixture', observedAt: '2026-09-01T23:50:00Z', expiresAt: '2026-09-02T00:00:00Z' });
  assert.equal(await loadAcquisition(client, 'price', 'open', { nowMs: Date.parse('2026-09-02T00:01:00Z') }), null);
  assert.equal(await loadAcquisition(client, 'price', 'open', { requireComplete: true, allowStale: true }), null);
  await saveAcquisition(client, { namespace: 'price', identity: 'open', payload: { price: 3 },
    source: 'fixture', completedAt: '2026-09-02T00:01:00Z' });
  assert.equal((await loadAcquisition(client, 'price', 'open', { requireComplete: true })).payload.price, 3);
});

test('concurrent identical acquisitions make one provider request and invalid results are not cached', async () => {
  const { acquireCached } = await import('../src/shared/acquisition-cache.js');
  const client = database();
  let calls = 0;
  const options = { namespace: 'snapshot', identity: 'global', source: 'fixture', ttlMs: 1000,
    load: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { count: 1 }; },
    validate: (payload) => payload.count > 0 };
  const results = await Promise.all(Array.from({ length: 6 }, () => acquireCached(client, options)));
  assert.equal(calls, 1);
  assert.ok(results.every((row) => row.payload.count === 1));
  await assert.rejects(acquireCached(client, { ...options, identity: 'bad', load: async () => ({ count: 0 }) }), /invalid/i);
  assert.equal(client.rows.has('snapshot:bad'), false);
});

test('different acquisitions on one SQL session do not queue a lock ahead of the active acquisition save', async () => {
  const { acquireCached } = await import('../src/shared/acquisition-cache.js');
  const client = database();
  let active = 0;
  let peak = 0;
  const load = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return { ok: true };
  };
  await Promise.all(['A', 'B', 'C'].map((identity) => acquireCached(client, {
    namespace: 'session-locks', identity, immutable: true, load
  })));
  assert.equal(peak, 1, 'one SQL session must finish its current save/unlock before waiting for another lock');
});
