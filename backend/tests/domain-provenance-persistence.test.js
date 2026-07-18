import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL ||= 'postgresql://boonetools:test@127.0.0.1:5433/boonetools';

const { upsertRapidSwaps } = await import('../src/db/rapid-swaps-store.js');
const { upsertNodeVotes } = await import('../src/shared/node-votes.js');
const { saveRujiraReservePaymentEvents } = await import('../src/shared/rujira-reserve-payments.js');
const { canonicalNodeVoteKey, canonicalReservePaymentKey } = await import('../src/lib/provenance.js');

function makeClient(preferredRows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });

      if (normalized.startsWith('select canonical_key, preferred_source')) {
        const requested = new Set(params[0] || []);
        return {
          rows: preferredRows.filter((row) => requested.has(row.canonical_key)),
          rowCount: preferredRows.length
        };
      }

      if (normalized.includes('select count(*)::bigint as deleted_count')) {
        return { rows: [{ deleted_count: '0' }], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    }
  };
}

function findCall(client, fragment) {
  return client.calls.find((call) => call.sql.includes(fragment));
}

test('rapid swap persistence atomically prefers Dune and records both observations', async () => {
  const client = makeClient();
  const baseRow = {
    tx_id: 'ABC123',
    action_height: 123,
    action_date: '2026-07-17T12:00:00.000Z',
    observed_at: '2026-07-17T12:01:00.000Z',
    raw_action: {}
  };

  await upsertRapidSwaps(client, [
    baseRow,
    {
      ...baseRow,
      observed_at: '2026-07-17T12:02:00.000Z',
      raw_action: { source: 'dune', event_key: 'dune-row' }
    }
  ]);

  const domainInsert = findCall(client, 'insert into "rapid_swaps"');
  const observations = findCall(client, 'insert into "event_source_observations"');

  assert.ok(domainInsert);
  assert.match(domainInsert.sql, /"canonical_key"/);
  assert.match(domainInsert.sql, /"preferred_source"/);
  assert.match(domainInsert.sql, /on conflict \("canonical_key"\)/);
  assert.match(domainInsert.sql, /case lower\(coalesce\(excluded\."preferred_source"/);
  assert.match(domainInsert.sql, /"first_seen_at" = least/);
  assert.match(domainInsert.sql, /"last_seen_at" = greatest/);
  assert.ok(domainInsert.params.includes('dune'));
  assert.ok(domainInsert.params.includes(JSON.stringify({ source: 'dune', event_key: 'dune-row' })));
  assert.ok(observations);
  assert.equal(observations.params[0], 'rapid-swaps');
  assert.deepEqual(
    [observations.params[2], observations.params[10]],
    ['midgard', 'dune']
  );
  assert.ok(client.calls.indexOf(domainInsert) < client.calls.indexOf(observations));
  assert.ok(findCall(client, 'begin'));
  assert.ok(findCall(client, 'commit'));
});

test('node-vote upsert protects persisted Dune data without a read-before-write race', async () => {
  const row = {
    event_key: 'ws-event-key',
    tx_id: 'DEF456',
    height: 456,
    block_time: '2026-07-17T12:00:00.000Z',
    event_index: 1,
    node_address: 'thor1node',
    node_operator_address: 'thor1operator',
    node_status: 'Active',
    mimir_key: 'HALTTRADING',
    vote_value: '1',
    vote_value_numeric: '1',
    source: 'ws',
    raw_event: { source_event_key: 'ws-event-key' },
    observed_at: '2026-07-17T12:03:00.000Z',
    updated_at: '2026-07-17T12:03:00.000Z'
  };
  const canonicalKey = canonicalNodeVoteKey(row);
  const client = makeClient([{ canonical_key: canonicalKey, preferred_source: 'dune' }]);

  assert.equal(await upsertNodeVotes(client, [row]), 1);

  const canonical = findCall(client, 'insert into "node_votes"');
  const observation = findCall(client, 'insert into "event_source_observations"');
  assert.ok(canonical);
  assert.match(canonical.sql, /on conflict \("canonical_key"\)/);
  assert.match(canonical.sql, /when 'dune' then 100/);
  assert.match(canonical.sql, /"last_seen_at" = greatest/);
  assert.equal(observation.params[0], 'node-votes');
  assert.equal(observation.params[1], canonicalKey);
  assert.equal(observation.params[2], 'ws');
  assert.equal(observation.params[3], 'ws-event-key');
  assert.ok(client.calls.indexOf(canonical) < client.calls.indexOf(observation));
});

test('reserve-payment RPC upsert retains Dune preference atomically and keeps pruning', async () => {
  const row = {
    event_key: 'rpc-event-key',
    height: 789,
    block_time: '2026-07-17T12:00:00.000Z',
    tx_id: 'GHI789',
    sender: 'thor1sender',
    recipient: 'thor1reserve',
    memo: 'RESERVE',
    amount_base: '100000000',
    amount_rune: 1,
    rune_price_usd: 1.5,
    amount_usd: 1.5,
    coin: '100000000 THOR.RUNE',
    source: 'rpc',
    raw_event: { source_event_key: 'rpc-event-key' },
    updated_at: '2026-07-17T12:04:00.000Z'
  };
  const canonicalKey = canonicalReservePaymentKey(row);
  const client = makeClient([{ canonical_key: canonicalKey, preferred_source: 'dune' }]);

  assert.equal(await saveRujiraReservePaymentEvents(client, [row]), 1);

  const canonical = findCall(client, 'insert into "rujira_reserve_payment_events"');
  const observation = findCall(client, 'insert into "event_source_observations"');
  const prune = findCall(client, 'select count(*)::bigint as deleted_count');
  assert.ok(canonical);
  assert.match(canonical.sql, /on conflict \("canonical_key"\)/);
  assert.match(canonical.sql, /when 'dune' then 100/);
  assert.equal(observation.params[0], 'rujira-reserve-payments');
  assert.equal(observation.params[1], canonicalKey);
  assert.equal(observation.params[2], 'rpc');
  assert.equal(observation.params[3], 'rpc-event-key');
  assert.ok(prune);
  assert.ok(client.calls.indexOf(observation) < client.calls.indexOf(prune));
});
