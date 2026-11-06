import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceExcerpts, evidenceHash } from '../src/vote-references/sources.js';
import { validateGeneratedReference } from '../src/vote-references/generate.js';
import { collectReferenceKeys, createReferenceStore } from '../src/vote-references/catalog.js';
import { processReferences } from '../src/vote-references/worker.js';
import { SubscriptionError } from '../src/lib/chatgpt-subscription.js';
import { getVoteKeyReference, resolveVoteKeyReference } from '../../shared/node-votes/key-reference.js';

const commit = 'a'.repeat(40);
const evidence = sourceExcerpts('NEWCONTROL', [{ file: 'x/thorchain/example.go',
  text: 'package example\n// NewControl is consulted below\nvalue := GetMimir("NewControl")\nif value > 0 { enable() }' }], { commit, version: '3.21.1' });
const generated = { resolved: true, title: 'New control', summary: 'Enables the demonstrated operation.', values: 'Positive enables it.', exceptions: '',
  citations: [{ sourceId: 's1', start: 3, end: 4 }], reason: '' };

test('exact vote inventory deduplicates names and excludes invalid keys', () => {
  assert.deepEqual(collectReferenceKeys({ by_vote: [{ mimir_key: 'adr033' }, { mimir_key: '../bad' }],
    network_values: { mimirs: { ADR033: 1, NEWCONTROL: 0 } }, latest_events: [{ mimir_key: 'NEWCONTROL' }] }), ['ADR033', 'NEWCONTROL']);
});

test('evidence is bounded, source links pin exact commits, missing/out-of-range citations fail closed', () => {
  assert.equal(evidence.sources[0].start, 1);
  assert.equal(evidence.truncated, false);
  const result = validateGeneratedReference(JSON.stringify(generated), evidence);
  assert.equal(result.reference.status, 'generated');
  assert.match(result.reference.sources[0].url, new RegExp(`${commit}/x/thorchain/example.go#L3$`));
  assert.throws(() => validateGeneratedReference(JSON.stringify({ ...generated, citations: [{ sourceId: 'made-up', start: 1, end: 3 }] }), evidence));
  assert.throws(() => validateGeneratedReference(JSON.stringify({ ...generated, citations: [{ sourceId: 's1', start: 1, end: 800 }] }), evidence));
  assert.throws(() => validateGeneratedReference(JSON.stringify(generated), { ...evidence, truncated: true }));
  assert.throws(() => validateGeneratedReference(JSON.stringify(generated), { ...evidence, sources: evidence.sources.map(s => ({ ...s, file: 'constants/constants.go' })) }));
  const huge = sourceExcerpts('NEWCONTROL', [{ file: 'x/thorchain/example.go', text: 'NEWCONTROL'.repeat(13000) }], { commit, version: '3.21.1' });
  assert.equal(huge.truncated, true);
  assert.equal(huge.sources.length, 0);
  const repeated = sourceExcerpts('KEY', [{ file: 'x/thorchain/test.go', text: Array(100).fill('KEY').join('\n') }], { commit, version: '3.21.1' });
  assert.equal(repeated.sources.length, 1);
  assert.equal(repeated.sources[0].end, 100);
});

test('central references resolve only exact keys with safe pinned links and fall back for old servers', () => {
  const { reference } = validateGeneratedReference(JSON.stringify(generated), evidence);
  assert.equal(resolveVoteKeyReference('NEWCONTROL', { NEWCONTROL: reference }).status, 'generated');
  assert.equal(resolveVoteKeyReference('NEWCONTROL', {}).status, 'unknown');
  assert.equal(resolveVoteKeyReference('NEWCONTROL', { NEWCONTROL: { ...reference, key: 'OTHER' } }).status, 'unknown');
  assert.equal(resolveVoteKeyReference('NEWCONTROL', { NEWCONTROL: { ...reference, sources: [{ label: 'bad', url: 'javascript:alert(1)' }] } }).status, 'unknown');
  const forgedManual = resolveVoteKeyReference('NEWCONTROL', { NEWCONTROL: { ...reference,
    maintenance: 'manual', nonbinding: true, provenance: { kind: 'discord' } } });
  assert.equal(forgedManual.status, 'generated');
  assert.equal(forgedManual.maintenance, undefined);
  assert.equal(forgedManual.nonbinding, undefined);
  assert.equal(forgedManual.provenance, undefined);
});

function fakeStore(rows = [{ vote_key: 'NEWCONTROL', evidence_hash: '' }]) {
  const calls = [];
  return { calls, seed: async keys => calls.push(['seed', keys]), state: async () => ({}), due: async () => rows,
    claimCall: async () => { calls.push(['claim']); return true; }, pause: async (...args) => calls.push(['pause', ...args]),
    defer: async (...args) => calls.push(['defer', ...args]), unchanged: async (...args) => calls.push(['unchanged', ...args]),
    save: async (...args) => calls.push(['save', ...args]), publicCatalog: async () => ({}) };
}
const options = store => ({ store, payload: { by_vote: [{ mimir_key: 'NEWCONTROL' }] }, version: '3.21.1',
  source: { init: async () => {}, find: async () => evidence }, model: 'account-model',
  generate: async () => ({ text: JSON.stringify(generated), usage: { input_tokens: 1 } }) });

test('worker saves a validated summary once and unchanged evidence makes no model calls', async () => {
  const store = fakeStore();
  assert.equal((await processReferences(options(store))).processed, 1);
  assert.equal(store.calls.filter(c => c[0] === 'save').length, 1);
  const unchanged = fakeStore([{ vote_key: 'NEWCONTROL', evidence_hash: evidenceHash(evidence) }]);
  await processReferences({ ...options(unchanged), generate: () => assert.fail('unchanged evidence must not call the model') });
  assert.equal(unchanged.calls.filter(c => c[0] === 'unchanged').length, 1);
  assert.equal(unchanged.calls.filter(c => c[0] === 'claim').length, 0);
});

test('manual ADR032 exception never reaches GitLab discovery or model generation', async () => {
  const store = fakeStore([{ vote_key: 'ADR032', evidence_hash: '' }]);
  await processReferences({ ...options(store), payload: { by_vote: [{ mimir_key: 'ADR032' }] },
    source: { init: () => assert.fail('manual-only work needs no repository'), find: () => assert.fail('Discord exception must not resolve the colliding GitLab proposal') },
    generate: () => assert.fail('manual exception must not generate') });
  assert.equal(store.calls.some(call => ['claim', 'defer', 'save'].includes(call[0])), false);
});

test('missing source or ambiguous code never calls the model or destroys a saved description', async () => {
  const store = fakeStore();
  await processReferences({ ...options(store), source: { init: async () => {}, find: async () => ({ sources: [], reason: 'source_not_found' }) },
    generate: () => assert.fail('no source') });
  assert.equal(store.calls.some(c => c[0] === 'save'), false);
  assert.equal(store.calls.some(c => c[0] === 'claim'), false);
  assert.deepEqual(store.calls.find(c => c[0] === 'defer').slice(1), ['NEWCONTROL', 'source_not_found']);
});

test('subscription limits pause the whole worker without trying another key, billing path or deleting saved entries', async () => {
  const store = fakeStore([{ vote_key: 'NEWCONTROL' }, { vote_key: 'SECOND' }]);
  let requests = 0;
  await processReferences({ ...options(store), generate: async () => { requests++; throw new SubscriptionError('subscription_sharing_usage_limit_exceeded'); } });
  assert.equal(requests, 1);
  assert.deepEqual(store.calls.find(c => c[0] === 'pause').slice(1), ['subscription_sharing_usage_limit_exceeded', 360]);
  assert.equal(store.calls.some(c => c[0] === 'save'), false);
  store.state = async () => ({ paused_until: new Date(Date.now() + 3600_000), last_error: 'subscription_sharing_usage_limit_exceeded' });
  store.due = () => assert.fail('paused worker cannot process');
  assert.equal((await processReferences(options(store))).skipped, true);
});

test('configured usage ceiling and unknown network version make no model calls', async () => {
  const store = fakeStore();
  store.claimCall = async () => false;
  await processReferences({ ...options(store), generate: () => assert.fail('usage ceiling') });
  await processReferences({ ...options(store), version: null, source: { init: () => assert.fail('no source version') } });
});

test('Postgres catalog retains revision history and idempotent queueing', { skip: !process.env.DATABASE_URL }, async t => {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  t.after(() => client.end());
  const store = createReferenceStore(client);
  await store.seed(['NEWCONTROL', 'ADR30']);
  await store.seed(['NEWCONTROL']);
  assert.equal((await client.query("select count(*) from vote_key_references where vote_key='NEWCONTROL'")).rows[0].count, '1');
  assert.equal((await store.publicCatalog()).ADR30.status, 'reviewed');
  await store.seed(['ADR30']);
  assert.equal((await client.query("select count(*) from vote_key_reference_revisions where vote_key='ADR30' and outcome='reviewed_seed'")).rows[0].count, '1');
  const result = validateGeneratedReference(JSON.stringify(generated), evidence);
  await store.save('NEWCONTROL', evidence, evidenceHash(evidence), result, 'model', { input_tokens: 10 });
  await store.save('NEWCONTROL', evidence, evidenceHash(evidence), { resolved: false, reason: 'ambiguous' }, 'model', {});
  assert.equal((await store.publicCatalog()).NEWCONTROL.summary, result.reference.summary);
  assert.equal((await store.publicCatalog()).NEWCONTROL.update_pending, true);
  assert.equal((await client.query("select count(*) from vote_key_reference_revisions where vote_key='NEWCONTROL'")).rows[0].count, '2');
  assert.equal(await store.claimCall(1), true);
  assert.equal(await store.claimCall(1), false);
  await store.pause('subscription_sharing_usage_limit_exceeded', 360);
  assert.equal(await store.claimCall(100), false);
});

test('Postgres manual correction repairs saved aliases once, retains history, and rejects automatic overwrites', { skip: !process.env.DATABASE_URL }, async t => {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  t.after(() => client.end());
  const store = createReferenceStore(client);
  const keys = ['ADR032', 'ADR-032'];
  const legacy = key => ({ key, kind: 'adr', number: 32, status: 'reviewed', title: 'ADR 32: Base-layer limit orders',
    summary: 'Wrong GitLab document for this vote.', values: '', note: '',
    sources: [{ label: 'Official ADR on GitLab', file: 'docs/architecture/adr-032-limit-orders.md', commit,
      url: `https://gitlab.com/thorchain/thornode/-/blob/${commit}/docs/architecture/adr-032-limit-orders.md` }],
    review: { date: '2026-11-06', version: '3.21.1', commit } });
  for (const key of keys) await client.query(`insert into vote_key_references(vote_key,reference_json,source_version,last_error)
    values($1,$2,'3.21.1','insufficient_evidence')`, [key, legacy(key)]);
  await client.query(`insert into vote_key_reference_revisions
    (vote_key,evidence_hash,source_version,reference_json,evidence_json,outcome)
    values('ADR032','','3.21.1',$1,'{}','reviewed_seed')`, [legacy('ADR032')]);

  // ADR-032 has left the current inventory; its previously stored entry must
  // still be repaired, and its absent seed audit record must be preserved.
  await store.seed(['ADR032']);
  await store.seed(['ADR032']);
  for (const key of keys) {
    const saved = (await client.query('select * from vote_key_references where vote_key=$1', [key])).rows[0];
    assert.deepEqual(saved.reference_json, getVoteKeyReference(key));
    assert.equal(saved.last_error, '');
    const history = (await client.query('select reference_json,outcome,evidence_json from vote_key_reference_revisions where vote_key=$1 order by id', [key])).rows;
    assert.equal(history.length, 2);
    assert.deepEqual(history[0].reference_json, legacy(key));
    assert.equal(history[1].outcome, 'manual_override');
    assert.equal(history[1].evidence_json.provenance.kind, 'discord');
    const overwrite = await store.save(key, { ...evidence, key }, 'wrong-evidence', { resolved: true, reference: legacy(key) }, 'model', {});
    assert.equal(overwrite.reason, 'manual_reference');
    await store.defer(key, 'source_not_found');
    await store.unchanged(key, '9.9.9');
    assert.deepEqual((await store.publicCatalog())[key], getVoteKeyReference(key));
    assert.equal((await client.query('select count(*) from vote_key_reference_revisions where vote_key=$1', [key])).rows[0].count, '2');
  }
  // Queue exclusion uses the trusted key allowlist, not mutable saved metadata.
  await client.query("update vote_key_references set next_attempt_at=now(),source_version='1.0.0' where vote_key=any($1::text[])", [keys]);
  assert.equal((await store.due('9.9.9', 1000)).some(row => keys.includes(row.vote_key)), false);
});
