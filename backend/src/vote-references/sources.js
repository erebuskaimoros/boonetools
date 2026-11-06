import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { THORNODE_SOURCE_REPO, THORNODE_SOURCE_WEB, THORNODE_GITLAB_API } from '../../../shared/external-providers.js';
import { adrNumber } from '../../../shared/node-votes/keys.js';
import { requestFromProviders } from '../lib/provider-client.js';

const exec = promisify(execFile);
export const sourceUrl = (commit, file, line) => `${THORNODE_SOURCE_WEB}/-/blob/${commit}/${file}${line ? `#L${line}` : ''}`;
const hash = text => createHash('sha256').update(text).digest('hex');

export function evidenceHash(evidence) {
  // A release's SHA alone is not a reason to spend another model request when
  // the relevant source is unchanged. Line ranges/text + version are material.
  return hash(JSON.stringify({ key: evidence.key, version: evidence.version,
    sources: evidence.sources.map(({ file, start, text, proposal }) => ({ file, start, text, proposal })) }));
}

export function sourceExcerpts(key, files, { commit, version, kind = 'mimir', proposal = false } = {}) {
  const sources = [];
  let size = 0;
  for (const { file, text } of files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file) || file.includes('..')) continue;
    const lines = text.split('\n');
    const matches = kind === 'adr' ? [0] : lines.flatMap((line, index) => line.toUpperCase().includes(key) ? [index] : []);
    const ranges = [];
    for (const index of matches) {
      const start = kind === 'adr' ? 0 : Math.max(index - 45, 0);
      const end = kind === 'adr' ? lines.length - 1 : Math.min(lines.length - 1, index + 65);
      const last = ranges.at(-1);
      if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
      else ranges.push({ start, end });
    }
    for (const { start, end } of ranges) {
      const content = lines.slice(start, end + 1).join('\n');
      if (size + content.length > 125_000 || sources.length >= 18) return { key, version, kind, sources, truncated: true };
      size += content.length;
      sources.push({ id: `s${sources.length + 1}`, file, commit, start: start + 1, end: end + 1, text: content, proposal });
    }
  }
  return { key, version, kind, sources, truncated: false };
}

export function createSourceRepository(directory, { request = requestFromProviders, run = exec } = {}) {
  const repo = join(directory, 'thornode.git');
  const git = async args => (await run('git', ['--git-dir', repo, ...args], {
    timeout: 90_000, maxBuffer: 10_000_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout.trimEnd();
  let release;
  let version;
  async function fetchRef(ref) {
    // No shell, repository hooks, checkout, or execution of upstream code.
    await git(['fetch', '--depth=1', '--no-tags', THORNODE_SOURCE_REPO, ref]);
    return git(['rev-parse', 'FETCH_HEAD^{commit}']);
  }
  async function init(nextVersion) {
    if (!/^\d+\.\d+\.\d+$/.test(nextVersion)) throw new Error('No verified THORNode version');
    version = nextVersion;
    await mkdir(directory, { recursive: true });
    await run('git', ['init', '--bare', repo], { timeout: 10_000 });
    const cached = await readFile(join(directory, 'release.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (cached?.version === version && /^[a-f0-9]{40}$/.test(cached.commit)) {
      await git(['cat-file', '-e', `${cached.commit}^{commit}`]);
      release = cached.commit;
    } else {
      release = await fetchRef(`refs/tags/v${version}`);
      await git(['update-ref', `refs/boonetools/releases/${version}`, release]);
      await writeFile(join(directory, 'release.json'), JSON.stringify({ version, commit: release }));
    }
    return { version, commit: release };
  }
  async function filesAt(commit, paths) {
    return Promise.all(paths.map(async file => ({ file, text: await git(['show', `${commit}:${file}`]) })));
  }
  async function adrFiles(commit, number) {
    const listing = await git(['ls-tree', '-r', '--name-only', commit, '--', 'docs/architecture']);
    const pattern = new RegExp(`(?:^|/)adr-0*${number}[-.]`, 'i');
    return listing.split('\n').filter(file => pattern.test(file) && file.endsWith('.md'));
  }
  async function find(key) {
    if (!release) throw new Error('Initialize source version first');
    if (!/^[A-Z0-9_.-]{1,180}$/.test(key)) return { key, version, sources: [], kind: 'mimir', reason: 'invalid_key' };
    const number = adrNumber(key);
    if (number != null) {
      let commit = release;
      let paths = await adrFiles(commit, number);
      let proposal = false;
      if (!paths.length) {
        // Discover only the exact numbered proposal. Multiple candidates remain
        // unresolved rather than choosing the most recent similarly named MR.
        const result = await request({ bases: [THORNODE_GITLAB_API],
          path: `/merge_requests?state=opened&per_page=100&search=${encodeURIComponent(`ADR`)}&in=title`,
          timeoutMs: 20_000, providerPool: false });
        const list = result.data ?? result.payload ?? result;
        if (!Array.isArray(list) || list.length >= 100) return { key, version, kind: 'adr', sources: [], reason: 'ambiguous_proposals' };
        const matches = list.filter(mr => new RegExp(`\\bADR[- ]?0*${number}\\b`, 'i').test(mr.title));
        if (matches.length !== 1 || !Number.isInteger(matches[0].iid)) return { key, version, kind: 'adr', sources: [], reason: 'source_not_found' };
        commit = await fetchRef(`refs/merge-requests/${matches[0].iid}/head`);
        paths = await adrFiles(commit, number);
        proposal = true;
      }
      if (paths.length !== 1) return { key, version, kind: 'adr', sources: [], reason: 'ambiguous_source' };
      return sourceExcerpts(key, await filesAt(commit, paths), { version, commit, kind: 'adr', proposal });
    }
    let listing;
    try { listing = await git(['grep', '-il', '-F', '-e', key, release, '--', 'x/thorchain', 'bifrost', 'constants']); }
    catch (error) { if (error.code === 1) return { key, version, kind: 'mimir', sources: [], reason: 'source_not_found' }; throw error; }
    const paths = listing.split('\n').map(file => file.slice(release.length + 1)).filter(file => file.endsWith('.go'));
    if (paths.length > 40) return { key, version, kind: 'mimir', sources: [], reason: 'source_too_broad' };
    // Include consumers before defaults and tests. The generator must abstain
    // when the snippets do not establish actual lookup/use and value semantics.
    paths.sort((a, b) => Number(a.startsWith('constants/') || a.endsWith('_test.go')) - Number(b.startsWith('constants/') || b.endsWith('_test.go')) || a.localeCompare(b));
    const evidence = sourceExcerpts(key, await filesAt(release, paths), { version, commit: release });
    if (!evidence.sources.some(s => !s.file.startsWith('constants/') && !s.file.endsWith('_test.go'))) evidence.reason = 'no_consumer';
    if (!evidence.truncated && !evidence.reason) {
      const helpers = ['x/thorchain/keeper/v1/keeper_mimir_mainnet.go', 'x/thorchain/keeper/v1/keeper_config.go',
        'x/thorchain/keeper/v1/keeper.go', 'x/thorchain/keeper/mimir_cache.go',
        'constants/constants.go', 'constants/constantname_string.go'];
      // Mainnet lookup/fallback/string conversion is required context, not
      // evidence that this particular key has a behavioral consumer.
      for (const file of helpers) {
        const [{ text }] = await filesAt(release, [file]);
        evidence.sources.push({ id: `s${evidence.sources.length + 1}`, role: 'context', file,
          commit: release, start: 1, end: text.split('\n').length, text, proposal: false });
      }
      if (JSON.stringify(evidence).length > 150_000) evidence.truncated = true;
    }
    return evidence;
  }
  return { init, find };
}
