# Vote-key descriptions

The Vote Tracker bundles reviewed descriptions; opening an info panel makes no
network request. `shared/node-votes/key-reference.js` owns the catalog and exact
key/family resolution. `VoteKeyInfoPanel.svelte` renders plain text and pinned
GitLab source links. The existing collector, quorum rules, and vote records are
unchanged.

The initial inventory covers all 165 keys in the production six-month summary
observed November 6, 2026. The key-only fixture is in
`tests/fixtures/node-votes/reference-keys.json`. Coverage includes ADRs 23, 24,
25, 26, 28, 29, 30, 31, and 32; two software upgrades; exact Mimirs and reviewed
chain/asset/THORName/contract/vault families. Nine historical keys have explicit
unrecognized/malformed-key explanations. New unknown keys remain visible with
an honest missing-review message; they are never fuzzily mapped to another key.
The info controls appear in By Vote, a node’s vote history, current Mimirs, and
recent events. Compiled constants are not presented as vote keys.

## Source review

- Runtime behavior: mainnet version 3.21.1, commit
  `72b7c6348833bb9b933655c265bddcee79699184`. Read the consumer, not only the
  constant name or default. Halt start heights, pause end heights, immediate
  switches, base-unit RUNE amounts, and basis points have distinct semantics.
- ADR 24: archived official repository revision
  `ae3cc9cfe86caef0212e699daf2f4a13ee322395`,
  `docs/architecture/adr-024-revenue-pol.md`. Its text is absent from the current
  architecture tree; the panel explains that the implemented Mimir names differ.
- ADR 31: proposal revision `c39c90774a4bccb4b4f648e251b7037810ae0062`,
  `docs/architecture/adr-031-rujira-alignment.md` (MR !4971).
- ADR 32: one-off, nonbinding **No Bond Retribution for Dissent** proposal,
  published in [Discord](https://discord.com/channels/838986635756044328/839001804812451873/1557035254051770391).
  The site operator supplied the full proposal text and its direct message URL
  on November 6. The full supplied text is retained in
  `shared/node-votes/manual-references.js` and in the saved revision evidence.
  The distinct GitLab limit-orders proposal uses the same number; it is not
  the meaning of this tracked vote.
- Other covered ADRs use their documents in the reviewed release. A document’s
  proposal status and a vote count do not imply deployment; the panels say so.

GitLab source permalinks were checked against the release files or the official
repository file API and pin commits so lines cannot drift beneath an existing
explanation. The ADR 32 exception links to the operator-supplied Discord message
and is explicitly distinguished from code-derived summaries.

To refresh the catalog, compare current tracker keys and the deployed THORNode
version, review affected consumers and ADR documents, update explanations and
source commits/lines together, and refresh the key-only fixture. Add a focused
resolver test for new families or exceptional spellings. Do not add tests that
match Svelte markup or exact prose.

## Preferred ADR spelling

`adr-preference.js` groups only explicit `ADR<number>` / `ADR-<number>` spelling
variants, ignoring zero padding for documentation identity. Within each group,
the highlighted key has the most distinct current active validators voting on
that exact key, across all values. This is participation in a key, not approval
of a particular proposal option. The main badge reads **most voted**.

Counts come from the full unfiltered summary and the current active-node roster.
Historical event totals, repeated votes, retired nodes, and removed stances do
not increase support. No winner is selected when support is tied, all counts are
zero, the snapshot is incomplete, or only stored historical stances are available.
Each raw key retains its own values, consensus, history, copy action, and details.

Validation: `node --test tests/node-votes-*.test.js`, `npm run check`, and
`npm run build`, plus desktop/mobile browser checks for positioning, keyboard
focus, dismissal, source links, independent row expansion, and filtering.

## Subscription-backed updates

`boonetools-vote-key-references.timer` runs every five minutes when
`VOTE_REFERENCE_ENABLED=true`. It reads the existing vote and core snapshots;
it makes no extra Midgard or THORNode requests. Migration 079 stores the exact
key inventory, explanations, source evidence/revisions, attempts, and a durable
worker-wide pause. The summary job embeds the catalog in `key_references`.
The UI retains the bundled reviewed entries for older servers or absent entries.

New keys are queued once. The source resolver fetches the official THORNode
release matching the fresh cached `/version.current`, pins the commit, and
searches actual consumers plus lookup/default helpers and tests. It never runs
upstream code. ADRs resolve to release documents or an unambiguous, exactly
numbered open GitLab MR. Broad/truncated or missing source remains unresolved;
the worker does not invent a meaning or guess a similarly spelled key.

Only changed evidence triggers inference. The request contains public source
excerpts, not wallet data, server configuration, or credentials. Generated
responses must cite supplied IDs and valid line ranges; URLs are constructed
locally and pin source commits. Citation validation cannot prove an explanation
is correct: the UI explicitly labels these **AI summary · not human reviewed**.
Prior revisions remain in the database, and failed updates retain the saved
explanation. Reviewed entries are reused at their reviewed release. Source
checks retry daily; network-version changes bring entries forward in the queue.

### Manual vote exceptions

ADR032, ADR32, and ADR-032 share a bundled manual reference for the nonbinding
Discord pledge while retaining their separate on-chain vote identities. The
proposal asks operators not to use bans, upgrades, or Mimir changes to punish
votes, expression, or affiliations by taking or restricting bond funds. It
excludes automatic protocol slashing and conduct-based action for theft/exploit
participation, vault collusion, ongoing harmful negligence, and ADR-028 recovery.
The panel states the proposal's `ADR032 = 1` signal and two-thirds acceptance
criterion without claiming that acceptance has occurred or that code enforces it.

Only the bundled exception allowlist grants manual precedence. It overrides
stale/generated central entries, and the worker skips GitLab discovery and
inference for these keys. Seeding repairs previously saved aliases even if they
have left the current vote inventory, preserves their prior revision, and records
the supplied Discord evidence once. Automatic saves cannot overwrite the
exception; ordinary central entries cannot grant themselves manual provenance.
Other references retain the strict pinned-GitLab-link validation.

The default operational ceiling is two keys per run and 20 model calls per UTC
day, configurable with `VOTE_REFERENCE_MAX_CALLS_PER_DAY` (maximum 100). This is
an application guard against loops, not a statement about the subscription's
allowance. Quota/eligibility/auth errors pause the worker for six hours;
temporary transport errors pause it for 15 minutes. There is no API-key fallback
and no model call when a visitor opens the page.

## Authenticate and install on the server

Use OpenAI's supported [subscription OAuth flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
and [self-hosted VM procedure](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).
This connection is for the operator's worker, not website visitors.

```sh
node backend/scripts/chatgpt-subscription.mjs login --open
node backend/scripts/chatgpt-subscription.mjs models
VOTE_REFERENCE_MODEL=gpt-6.1-sol node backend/scripts/chatgpt-subscription.mjs check
```

Default local storage is `~/.config/boonetools/vote-references`; all credential
files are owner-only. The callback checks state/PKCE, JWT signature, issuer,
audience, expiry, nonce, exact account identity, and granted subscription scope.
The model slug must be present in that account's model list.

After the code passes CI and is deployed, create the server's private auth
directory owned by `deploy` under `/var/lib/boonetools-vote-references/auth`.
Run `init-host` there with `VOTE_REFERENCE_AUTH_DIR` set, creating a distinct
stable server host ID. Transfer only the credentials through SSH/stdin into a
0600 temporary file, atomically rename it, and retain the server's host ID rather
than importing the laptop's host file. Never put tokens in shell arguments,
logs, frontend env, source control, or the database. Remove the transferred
local credential session after the server check: only the server may refresh
that rotating token. A later local login must create a separate session.

Configure the server-owned backend env with `VOTE_REFERENCE_ENABLED=true`, the
auth/source directories, and the selected model. Run the `check` command as
`deploy`, then start the timer. Verify its next run, the public
`/functions/v1/node-votes-summary` catalog, and an info panel in the browser.
Deploy backend first. No historical vote backfill or chain acquisition reset
is involved.

Refresh and inference are serialized by a private credential lock and the job's
Postgres advisory lock. A dead local PID's credential lock can be recovered;
an active owner is never displaced. A lock with missing ownership metadata
requires an operator to verify that no worker/login is running before removing
only that stale lock directory. Failed token refresh never overwrites credentials.
To disconnect, stop/disable the worker and revoke BooneTools Vote References in
ChatGPT settings; delete the protected session only after revocation.

Focused integration checks:

```sh
node --test backend/tests/chatgpt-subscription.test.js backend/tests/vote-key-references.test.js
node backend/scripts/with-test-postgres.mjs -- node --test backend/tests/vote-key-references.test.js
```
