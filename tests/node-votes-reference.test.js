import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getVoteKeyReference, resolveVoteKeyReference, REFERENCE_REVIEW } from '../src/lib/node-votes/key-reference.js';
import { adrNumber, buildAdrPreferences } from '../src/lib/node-votes/adr-preference.js';

const inventory = JSON.parse(readFileSync(new URL('./fixtures/node-votes/reference-keys.json', import.meta.url)));
const active = ['a', 'b', 'c'].map((node_address) => ({ node_address }));
const row = (key, nodes, extra = {}) => ({ mimir_key: key, current_vote_source: 'thornode-active-node-mimir',
  values: [{ value: '1', nodes, count: nodes.length }], ...extra });

test('ADR032 uses the nonbinding Discord commitment despite the GitLab number collision', () => {
  for (const key of ['ADR032', 'ADR32', 'ADR-032']) {
    const reference = getVoteKeyReference(key);
    assert.equal(reference.title, 'ADR 32: No Bond Retribution for Dissent');
    assert.equal(reference.key, key);
    assert.equal(reference.nonbinding, true);
    assert.equal(reference.maintenance, 'manual');
    assert.equal(reference.provenance.kind, 'discord');
    assert.equal(reference.sources.some(source => source.url?.includes('gitlab.com')), false);
    const stale = { ...reference, title: 'ADR 32: Base-layer limit orders', maintenance: undefined,
      sources: [{ label: 'Official ADR on GitLab', url: `https://gitlab.com/thorchain/thornode/-/blob/${'a'.repeat(40)}/docs/architecture/adr-032-limit-orders.md` }] };
    assert.equal(resolveVoteKeyReference(key, { [key]: stale }).title, reference.title);
    assert.equal(resolveVoteKeyReference(key, { [key]: { ...stale, status: 'generated' } }).title, reference.title);
  }
  assert.equal(getVoteKeyReference('ADR030').sources[0].file, 'docs/architecture/adr-030-delegated-node-operator-permissions.md');
  assert.equal(getVoteKeyReference('ADR032EXTRA').status, 'unknown');
});

test('every observed vote key has a reviewed explanation or an explicit reviewed mismatch', () => {
  assert.equal(new Set(inventory.keys).size, 165);
  for (const key of inventory.keys) {
    const reference = getVoteKeyReference(key);
    assert.equal(reference.key, key);
    assert.ok(['reviewed', 'unrecognized'].includes(reference.status), key);
    if (reference.maintenance === 'manual') {
      assert.equal(reference.provenance.kind, 'discord');
      assert.equal(reference.provenance.suppliedBy, 'site-operator');
      assert.ok(reference.provenance.text.length > 100);
      assert.deepEqual(reference.sources, [{ label: 'Original proposal on Discord',
        url: 'https://discord.com/channels/838986635756044328/839001804812451873/1557035254051770391' }]);
      continue;
    }
    assert.ok(reference.sources.length > 0, key);
    for (const link of reference.sources) {
      const url = new URL(link.url);
      assert.equal(url.origin, 'https://gitlab.com');
      assert.ok(url.pathname.startsWith('/thorchain/thornode/-/blob/'), key);
      assert.match(link.commit, /^[0-9a-f]{40}$/);
      assert.ok(link.file);
    }
  }
});

test('ADR aliases share the official document without replacing raw key identity', () => {
  const results = ['ADR30', 'ADR030', 'ADR-030'].map(getVoteKeyReference);
  assert.deepEqual(results.map((r) => r.number), [30, 30, 30]);
  assert.equal(new Set(results.map((r) => r.key)).size, 3);
  assert.equal(new Set(results.map((r) => r.sources[0].url)).size, 1);
  assert.equal(adrNumber('ARD26'), null);
  assert.equal(adrNumber('ADR30EXTRA'), null);
  assert.equal(adrNumber('ADR--030'), null);
  assert.equal(getVoteKeyReference('ADR999').status, 'unknown');
});

test('archived and unmerged ADRs link to the actual reviewed document revisions', () => {
  for (const key of ['ADR024', 'ADR031']) {
    const result = getVoteKeyReference(key);
    assert.equal(result.kind, 'adr');
    assert.notEqual(result.sources[0].commit, REFERENCE_REVIEW.commit);
    assert.equal(result.sources[0].file.startsWith('docs/architecture/'), true);
  }
});

test('strict spelling and family scope prevent unknown controls inheriting recognized meanings', () => {
  for (const key of ['HALTTRRONTRADING', 'HALTSIGNGING', 'CONFMULTIPLERBASSPOINTS-LTC',
    'HALTCONTRACT-YEVLEC', 'HALTWASMCONTRACT', 'WASMDEPLOYENABLED', 'ARD26', 'CONFMULTIPLIERBASISPOINTS']) {
    assert.equal(getVoteKeyReference(key).status, 'unrecognized', key);
  }
  for (const key of ['HALTTRONTRADING', 'HALTSIGNING', 'CONFMULTIPLIERBASISPOINTS-LTC', 'HALTWASMCONTRACT-YEVLEC']) {
    assert.equal(getVoteKeyReference(key).status, 'reviewed', key);
  }
  for (const key of ['HALTUNKNOWNTRADING', 'ADR-030-WRONG', 'HALTWASMCONTRACT-TOOLONG', '__proto__', '<script>']) {
    const reference = getVoteKeyReference(key);
    assert.equal(reference.status, 'unknown', key);
    assert.deepEqual(reference.sources, []);
  }
});

test('different halt semantics resolve to their own consumers, never a generic toggle', () => {
  const blockHalt = getVoteKeyReference('HALTTRONCHAIN');
  const endPause = getVoteKeyReference('NODEPAUSECHAINGLOBAL');
  const immediate = getVoteKeyReference('HALTMEMOLESS');
  const lp = getVoteKeyReference('PAUSELPDEPOSIT-TRON-USDT-TEST');
  assert.notEqual(blockHalt.values, endPause.values);
  assert.notEqual(blockHalt.values, immediate.values);
  assert.notEqual(lp.sources[0].line, getVoteKeyReference('PAUSELP').sources[0].line);
  assert.equal(getVoteKeyReference('UPGRADE-3.21.0').kind, 'upgrade');
  assert.equal(getVoteKeyReference('halting').status, 'unknown');
});

test('preferred ADR spelling counts current active validators, not events or inactive nodes', () => {
  const rows = [row('ADR030', ['a', 'b'], { historical_vote_events: 2 }),
    row('ADR30', ['c', 'retired'], { historical_vote_events: 9000 }), row('ADR-030', [])];
  const result = buildAdrPreferences(rows, active, true);
  assert.equal(result.ADR030.state, 'preferred');
  assert.equal(result.ADR30.state, 'alternate');
  assert.equal(result.ADR30.count, 1);
  assert.equal(result['ADR-030'].preferred, 'ADR030');
  assert.deepEqual(rows[1].values[0].nodes, ['c', 'retired']);
});

test('each validator counts once per key across values, including a zero stance but not removals', () => {
  const result = buildAdrPreferences([row('ADR031', [], { values: [
    { value: '1', nodes: ['a', 'a'], count: 2 }, { value: '0', nodes: ['a', 'b'], count: 2 },
    { value: '-1', nodes: ['c'], count: 1 }
  ] }), row('ADR31', ['c'])], active, true);
  assert.equal(result.ADR031.count, 2);
  assert.equal(result.ADR031.preferred, 'ADR031');
});

test('ties and all-zero support never choose a correct spelling', () => {
  let result = buildAdrPreferences([row('ADR032', ['a']), row('ADR-032', ['b'])], active, true);
  assert.equal(result.ADR032.state, 'tied');
  assert.equal(result.ADR032.preferred, null);
  result = buildAdrPreferences([row('ADR032', []), row('ADR-032', [])], active, true);
  assert.equal(result.ADR032.state, 'no-votes');
  assert.equal(result.ADR032.preferred, null);
});

test('incomplete chain snapshots and stored historical stances cannot establish a preferred key', () => {
  const rows = [row('ADR030', ['a', 'b']), row('ADR30', ['c'])];
  assert.equal(buildAdrPreferences(rows, active, false).ADR030.state, 'unavailable');
  assert.equal(buildAdrPreferences(rows, [], true).ADR030.state, 'unavailable');
  rows[1].current_vote_source = 'stored-latest-stance';
  assert.equal(buildAdrPreferences(rows, active, true).ADR030.state, 'unavailable');
  rows[1] = row('ADR30', ['c'], { values: [{ value: '1', count: 3, nodes: ['c'] }] });
  assert.equal(buildAdrPreferences(rows, active, true).ADR030.preferred, null);
});

test('new snapshot changes the preferred spelling without carrying over old support', () => {
  const before = buildAdrPreferences([row('ADR030', ['a', 'b']), row('ADR30', ['c'])], active, true);
  const after = buildAdrPreferences([row('ADR030', ['a']), row('ADR30', ['b', 'c'])], active, true);
  assert.equal(before.ADR030.preferred, 'ADR030');
  assert.equal(after.ADR030.preferred, 'ADR30');
  assert.deepEqual(buildAdrPreferences([row('ARD26', ['a'])], active, true), {});
});
