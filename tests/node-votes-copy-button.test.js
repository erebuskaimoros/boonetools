import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboardSource = readFileSync(
  new URL('../src/lib/NodeVotes.svelte', import.meta.url),
  'utf8'
);
const copyButtonSource = readFileSync(
  new URL('../src/lib/node-votes/VoteKeyCopy.svelte', import.meta.url),
  'utf8'
);

test('every rendered vote key has a copy button beside it', () => {
  assert.match(
    dashboardSource,
    /<strong>\{row\.mimir_key\}<\/strong>\s*<\/button>\s*<VoteKeyCopy voteKey=\{row\.mimir_key\}/
  );
  assert.match(
    dashboardSource,
    /<strong>\{vote\.mimir_key\}<\/strong>\s*<VoteKeyCopy voteKey=\{vote\.mimir_key\}/
  );
  assert.match(
    dashboardSource,
    /\{event\.mimir_key\}=\{displayNodeVote\(event\)\}[\s\S]*?<VoteKeyCopy voteKey=\{event\.mimir_key\}/
  );
});

test('vote-key copy control writes the exact key and exposes result feedback', () => {
  assert.match(copyButtonSource, /await copyToClipboard\(voteKey\)/);
  assert.match(copyButtonSource, /aria-label=\{buttonLabel\}/);
  assert.match(copyButtonSource, /aria-live="polite"/);
  assert.match(copyButtonSource, /export let keyLabel = 'vote key'/);
  assert.match(copyButtonSource, /`Copy \$\{keyLabel\}: \$\{voteKey\}`/);
  assert.match(copyButtonSource, /`\$\{feedbackLabel\} copied`/);
  assert.match(copyButtonSource, /`Could not copy \$\{keyLabel\}`/);
  assert.doesNotMatch(copyButtonSource, /class="bracket"/);
});

test('Effective Value History labels direct protocol safety changes without vote attribution', () => {
  assert.match(
    dashboardSource,
    /change\.change_source === 'protocol_safety'[\s\S]*?Protocol safety event[\s\S]*?not a validator vote/
  );
  assert.match(dashboardSource, /change\.security_message/);
});

test('Effective Value History labels authoritative validator-consensus changes', () => {
  assert.match(
    dashboardSource,
    /change\.change_source === 'validator_consensus'[\s\S]*?Validator consensus event[\s\S]*?effective Mimir change/
  );
  assert.match(dashboardSource, /matching node-vote threshold reached/);
});
