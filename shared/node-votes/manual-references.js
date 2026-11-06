// Explicit editorial exceptions outrank document-number discovery. This allowlist
// is bundled with the application; server/model metadata cannot add exceptions.
import { ADR032_DISCORD_PROPOSAL } from '../external-providers.js';

export const MANUAL_REFERENCE_KEY_PATTERN = '^ADR-?0*32$';
const manualKey = new RegExp(MANUAL_REFERENCE_KEY_PATTERN);

const dissentProposal = `## 📜 ADR-032: No Bond Retribution for Dissent

**TL;DR — Nodes are asked to publicly commit that they will not vote to take an operator's or bond provider's RUNE over a difference of opinion.**

### Why
This was alleged on unchained podcast I was on yesterday, and I'd like to send a clear message to market that this isn't a real thing to be concerned about. If node operators can help me send that message (which as much consensus as possible) that would be appreciated.

Nodes can collectively affect another node's bond: a \`BAN\` slashes bond, and a 2/3-approved upgrade can run a migration that moves funds. These tools exist for real threats such as malicious nodes and exploit recovery. But nothing says they **won't** be used to punish someone for disagreeing.

If speaking up could cost you or your bond providers real RUNE, the safe choice is silence. That's bad for governance and bad for THORChain.

### The commitment
By voting for ADR-032, a node operator pledges **not** to ban, approve an upgrade, or set mimir to slash, seize, burn, freeze or redirect anyone's bond because of:
- 🗳️ how they voted on mimir, ADRs or upgrades
- 💬 what they said, publicly or privately, including criticism of the protocol, devs or other nodes
- 🤝 which proposals, teams or roadmaps they support or oppose

### What it does NOT protect
Provable **conduct**, not opinion: the protocol's automatic slashing, theft or exploit participation, collusion against vaults, ongoing negligence that harms the network, and exploit recovery as described in ADR-028. Any such action must come with a public, conduct-based justification.

### How to vote
No code changes. Signal with node mimir:
\`ADR032 = 1\`
The ADR becomes **Accepted** once 2/3 of active nodes have signalled.

### The message
You are safe to disagree. Debate hard, vote your conscience, criticise freely. Your bond is not a weapon to be used against you. 🛡️`;

export function getManualVoteKeyReference(rawKey) {
  const key = String(rawKey ?? '').trim().toUpperCase();
  if (!manualKey.test(key)) return null;
  return {
    key, kind: 'adr', number: 32, status: 'reviewed', maintenance: 'manual', nonbinding: true,
    title: 'ADR 32: No Bond Retribution for Dissent',
    summary: 'A nonbinding commitment by node operators not to ban, approve an upgrade, or set Mimir to slash, seize, burn, freeze, or redirect an operator’s or bond provider’s bond because of their votes, public or private expression, criticism, or support for or opposition to proposals, teams, or roadmaps.',
    values: 'ADR032 = 1 signals support. The proposal defines acceptance as signals from two-thirds of active nodes. This is a public pledge with no code change or protocol-enforced protection; this description does not establish whether the acceptance threshold has been reached.',
    note: 'Exceptions include automatic protocol slashing and actions addressing provable theft or exploit participation, collusion against vaults, ongoing negligence that harms the network, and ADR-028 exploit recovery. The proposal requires a public, conduct-based justification for such action.',
    sources: [{ label: 'Original proposal on Discord', url: ADR032_DISCORD_PROPOSAL }],
    provenance: {
      kind: 'discord', suppliedBy: 'site-operator', suppliedOn: '2026-11-06',
      label: 'Discord proposal · text supplied by the site operator',
      note: 'This vote is a one-off exception to the GitLab ADR numbering. The original Discord message is linked.',
      text: dissentProposal
    },
    review: { date: '2026-11-06', version: '', commit: null }
  };
}
